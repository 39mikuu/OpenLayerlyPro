import {
  escapeInlineScriptBody,
  type IntegrationRenderPlan,
  type VerificationMeta,
} from "@/modules/site/public-security";

function scriptDataAttributes(
  data: Record<string, string | boolean>,
): Record<string, string | boolean> {
  return Object.fromEntries(Object.entries(data).map(([key, value]) => [`data-${key}`, value]));
}

function IntegrationScript({ nonce, plan }: { nonce: string; plan: IntegrationRenderPlan }) {
  const common = {
    nonce,
    async: plan.async,
    defer: plan.defer,
    integrity: plan.integrity,
    crossOrigin: plan.crossOrigin,
    ...scriptDataAttributes(plan.data),
  };
  if (plan.src) {
    // The structured integration controls async/defer semantics; src and CSP origins
    // are validated by the server registry rather than accepted as raw HTML.
    // eslint-disable-next-line @next/next/no-sync-scripts
    return <script key={plan.id} {...common} src={plan.src} />;
  }
  return (
    <script
      key={plan.id}
      {...common}
      dangerouslySetInnerHTML={{ __html: escapeInlineScriptBody(plan.inlineCode ?? "") }}
    />
  );
}

export function VerificationMetaElements({ items }: { items: VerificationMeta[] }) {
  return items.map((item) => (
    <meta key={`${item.name}:${item.content}`} name={item.name} content={item.content} />
  ));
}

export function IntegrationScriptElements({
  nonce,
  plans,
  placement,
}: {
  nonce: string;
  plans: IntegrationRenderPlan[];
  placement: "head" | "body";
}) {
  return plans
    .filter((plan) => plan.placement === placement)
    .map((plan) => <IntegrationScript key={plan.id} nonce={nonce} plan={plan} />);
}
