import { cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";

import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

type FieldControlProps = Record<string, unknown> & {
  "aria-describedby"?: string;
  "aria-invalid"?: boolean | "false" | "true";
  id?: string;
};

function mergeDescribedBy(existing: unknown, extraIds: string[]): string | undefined {
  const existingIds = typeof existing === "string" ? existing.split(/\s+/).filter(Boolean) : [];
  const ids = [...existingIds, ...extraIds].filter(Boolean);
  return ids.length > 0 ? Array.from(new Set(ids)).join(" ") : undefined;
}

export function FormField({
  children,
  className,
  description,
  error,
  id,
  label,
  required,
}: {
  children: ReactNode;
  className?: string;
  description?: ReactNode;
  error?: ReactNode;
  id: string;
  label: ReactNode;
  required?: boolean;
}) {
  const descriptionId = description ? `${id}-description` : null;
  const errorId = error ? `${id}-error` : null;
  const extraDescriptionIds = [descriptionId, errorId].filter((value): value is string =>
    Boolean(value),
  );
  const control = isValidElement<FieldControlProps>(children)
    ? cloneElement(children as ReactElement<FieldControlProps>, {
        "aria-describedby": mergeDescribedBy(
          children.props["aria-describedby"],
          extraDescriptionIds,
        ),
        "aria-invalid": error ? true : children.props["aria-invalid"],
        id,
      })
    : children;

  return (
    <div className={cn("space-y-2", className)}>
      <Label htmlFor={id}>
        {label}
        {required ? (
          <span aria-hidden="true" className="text-destructive">
            *
          </span>
        ) : null}
      </Label>
      {control}
      {description ? (
        <p id={descriptionId ?? undefined} className="text-xs text-muted-foreground">
          {description}
        </p>
      ) : null}
      {error ? (
        <p id={errorId ?? undefined} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
