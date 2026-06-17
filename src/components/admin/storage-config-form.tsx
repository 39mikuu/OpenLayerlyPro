"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { useT } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/client";

type StorageDriver = "local" | "s3";

type StorageEnvDefaults = {
  driver: StorageDriver;
  endpoint?: string;
  region: string;
  bucket?: string;
  forcePathStyle: boolean;
  accessKeyIdSet: boolean;
  secretAccessKeySet: boolean;
};

export type StorageAdminView = {
  driver: StorageDriver;
  endpoint?: string;
  region: string;
  bucket?: string;
  forcePathStyle: boolean;
  s3Configured: boolean;
  accessKeyIdSet: boolean;
  secretAccessKeySet: boolean;
  hasDbOverride: boolean;
  envDefaults: StorageEnvDefaults;
};

export function StorageConfigForm({ initial }: { initial: StorageAdminView }) {
  const router = useRouter();
  const t = useT();
  const [driver, setDriver] = useState<StorageDriver>(initial.driver);
  const [endpoint, setEndpoint] = useState(initial.endpoint ?? "");
  const [region, setRegion] = useState(initial.region);
  const [bucket, setBucket] = useState(initial.bucket ?? "");
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [forcePathStyle, setForcePathStyle] = useState(initial.forcePathStyle);
  const [loading, setLoading] = useState(false);
  const [testing, setTesting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function run(fn: () => Promise<void>, okMessage: string) {
    setLoading(true);
    setMessage(null);
    try {
      await fn();
      setAccessKeyId("");
      setSecretAccessKey("");
      setMessage(okMessage);
      router.refresh();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : t("admin.common.operationFailed"));
    } finally {
      setLoading(false);
    }
  }

  function save() {
    return run(
      () =>
        api("/api/admin/config/storage", {
          method: "PUT",
          body: {
            driver,
            endpoint,
            region,
            bucket,
            accessKeyId,
            secretAccessKey,
            forcePathStyle,
          },
        }),
      t("admin.storage.saved"),
    );
  }

  function importFromEnv() {
    const env = initial.envDefaults;
    setDriver(env.driver);
    setEndpoint(env.endpoint ?? "");
    setRegion(env.region);
    setBucket(env.bucket ?? "");
    setAccessKeyId("");
    setSecretAccessKey("");
    setForcePathStyle(env.forcePathStyle);
    setMessage(
      env.accessKeyIdSet && env.secretAccessKeySet
        ? t("admin.storage.imported")
        : t("admin.storage.importedIncomplete"),
    );
  }

  function restoreToEnv() {
    return run(
      () => api("/api/admin/config/storage", { method: "DELETE" }),
      t("admin.common.restoredEnv"),
    );
  }

  async function testConnection() {
    setTesting(true);
    setMessage(null);
    try {
      await api("/api/admin/integrations/storage/test", { method: "POST" });
      setMessage(t("admin.storage.testSuccess"));
    } catch (err) {
      setMessage(err instanceof Error ? err.message : t("admin.storage.testFailed"));
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="max-w-xl space-y-4">
      <div className="space-y-2">
        <Label htmlFor="storage-driver">{t("admin.storage.driver")}</Label>
        <select
          id="storage-driver"
          className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          value={driver}
          onChange={(event) => setDriver(event.target.value as StorageDriver)}
        >
          <option value="local">{t("admin.storage.local")}</option>
          <option value="s3">S3 / R2 / MinIO</option>
        </select>
      </div>

      {driver === "s3" && (
        <div className="space-y-4 rounded-lg border p-4">
          <div className="space-y-2">
            <Label>Endpoint</Label>
            <Input
              value={endpoint}
              onChange={(event) => setEndpoint(event.target.value)}
              placeholder="https://<account-id>.r2.cloudflarestorage.com"
            />
          </div>
          <div className="space-y-2">
            <Label>Region</Label>
            <Input
              value={region}
              onChange={(event) => setRegion(event.target.value)}
              placeholder={t("admin.storage.regionHint")}
            />
          </div>
          <div className="space-y-2">
            <Label>Bucket</Label>
            <Input
              value={bucket}
              onChange={(event) => setBucket(event.target.value)}
              placeholder={t("admin.storage.bucketHint")}
            />
          </div>
          <div className="space-y-2">
            <Label>Access Key ID</Label>
            <Input
              type="password"
              value={accessKeyId}
              onChange={(event) => setAccessKeyId(event.target.value)}
              placeholder={
                initial.accessKeyIdSet
                  ? t("admin.storage.credentialSet")
                  : t("admin.storage.accessKeyHint")
              }
              autoComplete="new-password"
            />
          </div>
          <div className="space-y-2">
            <Label>Secret Access Key</Label>
            <Input
              type="password"
              value={secretAccessKey}
              onChange={(event) => setSecretAccessKey(event.target.value)}
              placeholder={
                initial.secretAccessKeySet
                  ? t("admin.storage.credentialSet")
                  : t("admin.storage.secretKeyHint")
              }
              autoComplete="new-password"
            />
          </div>
          <Label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={forcePathStyle}
              onChange={(event) => setForcePathStyle(event.target.checked)}
            />
            {t("admin.storage.pathStyle")}
          </Label>
        </div>
      )}

      <div className="space-y-1 text-xs text-muted-foreground">
        <p>
          {t(initial.hasDbOverride ? "admin.common.dbOverride" : "admin.common.envSource")}
          {t("admin.storage.driverHint")}
        </p>
        <p>{t("admin.storage.profileHint")}</p>
      </div>
      {message && <p className="text-sm text-muted-foreground">{message}</p>}

      <div className="flex flex-wrap gap-2">
        <Button disabled={loading || testing} onClick={save}>
          {t("admin.common.save")}
        </Button>
        <Button variant="outline" disabled={loading || testing} onClick={importFromEnv}>
          {t("admin.common.importEnv")}
        </Button>
        <Button
          variant="outline"
          disabled={loading || testing || !initial.hasDbOverride}
          onClick={restoreToEnv}
        >
          {t("admin.common.restoreEnv")}
        </Button>
        <Button
          variant="outline"
          disabled={loading || testing || !initial.s3Configured}
          onClick={testConnection}
        >
          {testing ? t("admin.integrationTest.pending") : t("admin.storage.test")}
        </Button>
      </div>
    </div>
  );
}
