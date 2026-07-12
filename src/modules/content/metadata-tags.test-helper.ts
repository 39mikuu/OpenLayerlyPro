import type { Metadata } from "next";
import { createDefaultMetadata } from "next/dist/lib/metadata/default-metadata";
import { AlternatesMetadata } from "next/dist/lib/metadata/generate/alternate";
import { BasicMeta } from "next/dist/lib/metadata/generate/basic";
import { MetaFilter } from "next/dist/lib/metadata/generate/meta";
import { OpenGraphMetadata, TwitterMetadata } from "next/dist/lib/metadata/generate/opengraph";
import type { ResolvedMetadata } from "next/dist/lib/metadata/types/metadata-interface";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";

type ResolvedTitle = {
  absolute: string;
  template: string | null;
};

function resolveTitle(title: Metadata["title"]): ResolvedTitle | null {
  if (!title) return null;
  if (typeof title === "string") return { absolute: title, template: null };
  if ("absolute" in title && title.absolute) return { absolute: title.absolute, template: null };
  if ("default" in title && title.default) return { absolute: title.default, template: null };
  return null;
}

function resolveRobots(robots: Metadata["robots"]) {
  if (!robots) return null;
  if (typeof robots === "string") return { basic: robots, googleBot: null };
  const parts = [
    robots.index === false ? "noindex" : "index",
    robots.follow === false ? "nofollow" : "follow",
  ];
  return { basic: parts.join(", "), googleBot: null };
}

function resolveAlternates(alternates: Metadata["alternates"]) {
  const canonical = alternates?.canonical;
  const canonicalUrl =
    canonical && typeof canonical === "object" && "url" in canonical ? canonical.url : canonical;
  return {
    canonical: canonical
      ? {
          url: canonicalUrl,
        }
      : null,
    languages: null,
    media: null,
    types: null,
  };
}

function resolveOpenGraph(openGraph: Metadata["openGraph"]) {
  if (!openGraph) return null;
  return {
    ...openGraph,
    title: resolveTitle(openGraph.title),
  };
}

function resolveTwitter(twitter: Metadata["twitter"]) {
  if (!twitter) return null;
  return {
    ...twitter,
    title: resolveTitle(twitter.title),
  };
}

export function renderNextMetadataTags(metadata: Metadata): string {
  const resolved = {
    ...createDefaultMetadata(),
    ...metadata,
    title: resolveTitle(metadata.title),
    robots: resolveRobots(metadata.robots),
    alternates: resolveAlternates(metadata.alternates),
    openGraph: resolveOpenGraph(metadata.openGraph),
    twitter: resolveTwitter(metadata.twitter),
  } as ResolvedMetadata;
  const elements = MetaFilter([
    BasicMeta({ metadata: resolved }),
    AlternatesMetadata({ alternates: resolved.alternates }),
    OpenGraphMetadata({ openGraph: resolved.openGraph }),
    TwitterMetadata({ twitter: resolved.twitter }),
  ]).map((element, index) => createElement(Fragment, { key: index }, element));
  return renderToStaticMarkup(createElement(Fragment, null, elements));
}
