import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { FormField } from "@/components/admin/primitives/form-field";

function normalize(html: string) {
  return html.replace(/&quot;/g, '"');
}

describe("FormField", () => {
  it("associates the label, help text, and error with the control", () => {
    const html = normalize(
      renderToStaticMarkup(
        <FormField
          id="smtp-host"
          label="SMTP host"
          description="Use the saved host"
          error="Host is required"
        >
          <input aria-describedby="existing-help" />
        </FormField>,
      ),
    );

    expect(html).toContain('<label data-slot="label"');
    expect(html).toContain('for="smtp-host"');
    expect(html).toContain('id="smtp-host"');
    expect(html).toContain(
      'aria-describedby="existing-help smtp-host-description smtp-host-error"',
    );
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('id="smtp-host-description"');
    expect(html).toContain('id="smtp-host-error"');
    expect(html).toContain('role="alert"');
  });

  it("keeps required markers visual only", () => {
    const html = renderToStaticMarkup(
      <FormField id="required-field" label="Required field" required>
        <input />
      </FormField>,
    );

    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("Required field");
  });
});
