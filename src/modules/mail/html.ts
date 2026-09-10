export type EmailCallToAction = {
  label: string;
  url: string;
};

export type TransactionalEmailHtmlInput = {
  lang: string;
  siteName: string;
  title: string;
  paragraphs: string[];
  callout?: string;
  action: EmailCallToAction;
  footer: string;
};

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function renderTransactionalEmailHtml(input: TransactionalEmailHtmlInput): string {
  const paragraphs = input.paragraphs
    .filter(Boolean)
    .map(
      (paragraph) =>
        `<p style="margin:0 0 16px;color:#374151;font-size:16px;line-height:1.65;">${escapeHtml(paragraph)}</p>`,
    )
    .join("");
  const callout = input.callout
    ? `<div style="margin:24px 0;padding:18px 20px;border-radius:10px;background:#f3f4f6;color:#111827;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:30px;font-weight:700;letter-spacing:0.12em;text-align:center;">${escapeHtml(input.callout)}</div>`
    : "";

  return `<!doctype html>
<html lang="${escapeHtml(input.lang)}">
  <body style="margin:0;padding:0;background:#f3f4f6;font-family:Arial,'Helvetica Neue',sans-serif;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f3f4f6;">
      <tr>
        <td align="center" style="padding:32px 16px;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:600px;background:#ffffff;border-radius:14px;overflow:hidden;">
            <tr>
              <td style="padding:24px 32px;background:#111827;color:#ffffff;font-size:18px;font-weight:700;">${escapeHtml(input.siteName)}</td>
            </tr>
            <tr>
              <td style="padding:32px;">
                <h1 style="margin:0 0 24px;color:#111827;font-size:24px;line-height:1.3;">${escapeHtml(input.title)}</h1>
                ${paragraphs}${callout}
                <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:24px 0;">
                  <tr>
                    <td style="border-radius:8px;background:#2563eb;">
                      <a href="${escapeHtml(input.action.url)}" style="display:inline-block;padding:13px 22px;color:#ffffff;font-size:16px;font-weight:700;text-decoration:none;">${escapeHtml(input.action.label)}</a>
                    </td>
                  </tr>
                </table>
                <p style="margin:0;color:#6b7280;font-size:13px;line-height:1.6;word-break:break-all;">${escapeHtml(input.action.url)}</p>
                <p style="margin:24px 0 0;padding-top:20px;border-top:1px solid #e5e7eb;color:#6b7280;font-size:13px;line-height:1.6;">${escapeHtml(input.footer)}</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}
