import { closeDb } from "@/db";
import { hasOutstandingLoginCodeSmtpReservations } from "@/modules/restore/loginCodeSmtpReservations";

try {
  if (await hasOutstandingLoginCodeSmtpReservations()) {
    console.error(
      "restore-login-code-smtp-check: outstanding SMTP reservation in login_codes; keep all app/worker instances stopped and follow docs/deployment/login-code-smtp-recovery.md",
    );
    process.exitCode = 1;
  } else {
    console.log("restore-login-code-smtp-check: no outstanding SMTP reservations");
  }
} catch (error) {
  console.error("restore-login-code-smtp-check: unable to check login_codes; startup blocked");
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await closeDb();
}
