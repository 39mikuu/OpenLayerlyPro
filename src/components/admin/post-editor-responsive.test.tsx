import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { I18nProvider } from "@/components/i18n-provider";
import { zh } from "@/modules/i18n/messages/zh";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import { PostEditor } from "./post-editor";

function renderEditor() {
  return renderToStaticMarkup(
    <I18nProvider locale="zh" messages={zh}>
      <PostEditor
        post={{
          id: "11111111-1111-4111-8111-111111111111",
          title: "Responsive editor",
          slug: "responsive-editor",
          summary: "Summary",
          body: "Body",
          coverFileId: "22222222-2222-4222-8222-222222222222",
          visibility: "member",
          requiredTierId: "33333333-3333-4333-8333-333333333333",
          status: "draft",
          originalLocale: "en",
        }}
        tiers={[
          {
            id: "33333333-3333-4333-8333-333333333333",
            name: "Supporter",
            level: 10,
          },
        ]}
        attachedFiles={[
          {
            fileId: "44444444-4444-4444-8444-444444444444",
            kind: "attachment",
            originalName:
              "a-very-long-unbroken-post-attachment-name-that-must-remain-reachable-on-mobile.zip",
            sizeBytes: 1024,
          },
        ]}
        categories={[{ id: "category-1", name: "Category" }]}
        tags={[{ id: "tag-1", name: "Tag" }]}
        selectedCategoryIds={[]}
        selectedTagIds={[]}
      />
    </I18nProvider>,
  );
}

function renderNewEditor() {
  return renderToStaticMarkup(
    <I18nProvider locale="zh" messages={zh}>
      <PostEditor
        post={null}
        tiers={[]}
        attachedFiles={[]}
        categories={[]}
        tags={[]}
        selectedCategoryIds={[]}
        selectedTagIds={[]}
      />
    </I18nProvider>,
  );
}

describe("PostEditor responsive form", () => {
  it("keeps the new-post editor labelled and mobile-first", () => {
    const html = renderNewEditor();

    expect(html).toContain('data-testid="post-editor"');
    expect(html).toContain('data-testid="post-editor-title-row"');
    expect(html).toContain('data-testid="post-editor-actions"');
    expect(html).toContain('for="post-body"');
    expect(html).toContain('id="post-body"');
    expect(html).toContain('aria-describedby="post-body-description"');
    expect(html).toContain('id="post-body-description"');
    expect(html).toContain("sm:grid-cols-2");
    expect(html).toContain("w-full sm:w-auto");
    expect(html).toContain("此草稿尚未创建。填写标题和 Slug 后点击“创建草稿”");
    expect(html).not.toContain("当前更改已保存");
  });

  it("associates visible labels with post, upload, and translation controls", () => {
    const html = renderEditor();

    for (const id of [
      "post-title",
      "post-slug",
      "post-summary",
      "post-body",
      "post-visibility",
      "post-required-tier",
      "post-cover",
      "post-gallery-image",
      "post-gallery-attachment",
      "translation-locale",
    ]) {
      expect(html).toContain(`for="${id}"`);
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).toMatch(/for="translation-body-[^"]+"/);
    expect(html).toMatch(/id="translation-body-[^"]+"/);
  });

  it("renders mobile-first stacking hooks for fields, actions, files, and editor modes", () => {
    const html = renderEditor();

    expect(html).toContain('data-testid="post-editor"');
    expect(html).toContain('data-testid="post-editor-title-row"');
    expect(html).toContain('data-testid="post-editor-actions"');
    expect(html).toContain('data-testid="post-editor-attached-file"');
    expect(html.match(/data-testid="markdown-editor"/g)?.length).toBeGreaterThanOrEqual(2);
    expect(html.match(/w-full sm:w-auto/g)?.length).toBeGreaterThanOrEqual(7);
    expect(html).toContain("sm:grid-cols-2");
    expect(html).toContain("sm:flex-row");
    expect(html).toContain("file:max-w-full");
  });

  it("keeps long attachment names visible with explicit wrapping protection", () => {
    const html = renderEditor();

    expect(html).toContain(
      "a-very-long-unbroken-post-attachment-name-that-must-remain-reachable-on-mobile.zip",
    );
    expect(html).toContain("overflow-wrap:anywhere");
    expect(html).not.toContain("truncate");
  });
});
