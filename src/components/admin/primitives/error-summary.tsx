import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

export function ErrorSummary({ errors, title }: { errors: string[]; title: string }) {
  if (errors.length === 0) return null;
  return (
    <Alert aria-live="assertive" role="alert" variant="destructive">
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription className="text-destructive">
        {errors.length === 1 ? (
          errors[0]
        ) : (
          <ul className="list-disc space-y-1 pl-5">
            {errors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        )}
      </AlertDescription>
    </Alert>
  );
}
