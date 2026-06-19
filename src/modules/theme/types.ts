import type { ComponentType, ReactNode } from "react";

import type { Translate } from "@/modules/i18n";

/** 站内已注册的主题 id；后续新增主题在此扩展。 */
export type ThemeId = "builtin";

export type PostVisibility = "public" | "login" | "member";
export type TaxonomyLinkView = { name: string; slug: string };

/** 列表/卡片用的内容摘要（Core 已算好封面下载 URL）。 */
export type PostCardView = {
  slug: string;
  title: string;
  summary: string | null;
  coverUrl: string | null;
  visibility: PostVisibility;
  publishedAt: Date | null;
  categories?: TaxonomyLinkView[];
  tags?: TaxonomyLinkView[];
};

/** 站点外壳（header/nav/footer）所需数据。 */
export type SiteChromeView = {
  siteName: string;
  artistName: string;
  avatarUrl: string | null;
  logoUrl: string | null;
  socialLinks: { name: string; url: string }[];
  isLoggedIn: boolean;
  customFooterHtml: string;
};

export type HomePostView = PostCardView;

export type HomeView = {
  siteName: string;
  artistName: string;
  bio: string;
  avatarUrl: string | null;
  socialLinks: { name: string; url: string }[];
  isLoggedIn: boolean;
  tiers: TierCardView[];
  latestPosts: HomePostView[];
};

export type PostListView = {
  posts: PostCardView[];
  nextHref?: string | null;
};

export type PostImageView = { url: string; alt: string };
export type PostAttachmentView = { downloadHref: string; name: string; sizeBytes: number };

/**
 * 内容详情页所需数据。
 * Core 负责业务决策（allowed、requiredTierName、下载 URL）；主题只负责展示
 * （日期/大小格式化、locked 文案、布局）。
 */
export type PostDetailView = {
  title: string;
  publishedAt: Date | null;
  visibility: PostVisibility;
  requiredTierName: string | null;
  summary: string | null;
  coverUrl: string | null;
  isLoggedIn: boolean;
  allowed: boolean;
  body: string | null;
  images: PostImageView[];
  attachments: PostAttachmentView[];
  machineTranslated: boolean;
  categories: TaxonomyLinkView[];
  tags: TaxonomyLinkView[];
};

export type MembershipSummary = { tierName: string; endsAt: Date };

export type TierCardView = {
  id: string;
  name: string;
  priceLabel: string;
  description: string | null;
  durationDays: number;
  purchaseEnabled: boolean;
};

export type TiersView = {
  isLoggedIn: boolean;
  activeMembership: MembershipSummary | null;
  tiers: TierCardView[];
};

export type LoginView = {
  mode: "fan" | "admin";
  turnstileSiteKey?: string;
};

export type MeView = {
  email: string;
  isAdmin: boolean;
  membership: MembershipSummary | null;
};

export type OrderStatus =
  | "pending_review"
  | "pending_payment"
  | "approved"
  | "rejected"
  | "cancelled"
  | "reversed";

export type OrderView = {
  id: string;
  tierName: string;
  paymentMethodName: string | null;
  status: OrderStatus;
  amountLabel: string;
  durationDays: number;
  createdAt: Date;
  note: string | null;
  reviewNote: string | null;
};

export type MeOrdersView = {
  orders: OrderView[];
  paymentProcessing?: boolean;
};

export type CheckoutMethodView = {
  id: string;
  name: string;
  description: string | null;
  qrFileId: string | null;
};

export type CheckoutView = {
  tier: { id: string; name: string; priceLabel: string; durationDays: number };
  methods: CheckoutMethodView[];
  autoPaymentAvailable: boolean;
};

/** 主题需实现的组件槽（公开站点：外壳 + 首页 + 作品 + 会员/登录/账号/订单/收银台）。 */
export type ThemeComponents = {
  Chrome: ComponentType<{ view: SiteChromeView; t: Translate; children: ReactNode }>;
  Home: ComponentType<{ view: HomeView; t: Translate }>;
  PostList: ComponentType<{ view: PostListView; t: Translate }>;
  PostDetail: ComponentType<{ view: PostDetailView; t: Translate }>;
  Tiers: ComponentType<{ view: TiersView; t: Translate }>;
  Login: ComponentType<{ view: LoginView; t: Translate }>;
  Me: ComponentType<{ view: MeView; t: Translate }>;
  MeOrders: ComponentType<{ view: MeOrdersView; t: Translate }>;
  Checkout: ComponentType<{ view: CheckoutView; t: Translate }>;
};

/** 主题自带的颜色预设；hue=null 表示零覆盖（如默认 neutral）。 */
export type ThemeColorPreset = {
  id: string;
  name: string;
  hue: number | null;
};

/** 站点级主题配置（存 `site_settings.theme_config`）。 */
export type ThemeConfig = {
  colorPreset: string;
  customHue?: number;
};

/** 官方主题描述符；只承载表现层，不含业务逻辑。 */
export type Theme = {
  id: ThemeId;
  name: string;
  components: ThemeComponents;
  /** 主题自带的颜色预设（含默认）。 */
  colorPresets: ThemeColorPreset[];
  /** 未配置时使用的预设 id。 */
  defaultColorPresetId: string;
  /** 可选的主题取色模板；只接收 hue，CSS 变量和值完全由主题生成。 */
  colorVarsFromHue?: (hue: number) => {
    light: Record<string, string>;
    dark: Record<string, string>;
  };
};
