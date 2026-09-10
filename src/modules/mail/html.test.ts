import { describe, expect, it } from "vitest";

import { renderTransactionalEmailHtml } from "./html";

describe("transactional email HTML", () => {
  it("escapes all dynamic text and link attributes", () => {
    const html = renderTransactionalEmailHtml({
      lang: 'en"><script>',
      siteName: "Studio <Admin>",
      title: "Hello & welcome",
      paragraphs: ['Tier: <img src=x onerror="alert(1)">'],
      callout: "12<3456",
      action: { label: "Open >", url: 'https://example.test/?q=" onclick="alert(1)' },
      footer: "Ignore 'this'",
    });

    expect(html).toContain("Studio &lt;Admin&gt;");
    expect(html).toContain("Hello &amp; welcome");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).toContain("12&lt;3456");
    expect(html).toContain("q=&quot; onclick=&quot;alert(1)");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
  });
});
