import type { Theme } from "@/modules/theme/types";
import { builtinTheme } from "@/themes/builtin";

import { Chrome } from "./chrome";
import {
  BLOG_COLOR_PRESETS,
  BLOG_DEFAULT_COLOR_PRESET_ID,
  colorVarsFromHue,
} from "./color-presets";
import { Home } from "./home";
import { PostList } from "./post-list";

/**
 * 博客主题：文字优先的阅读形态（窄栏外壳、列表流首页、无封面文章列表）。
 * 交易性页面（详情锁定态 / 会员 / 登录 / 账号 / 订单 / 收银台）与内置主题
 * 没有形态分歧，直接复用其契约参考实现；未来需要分化时按槽 copy-on-write。
 */
export const blogTheme: Theme = {
  id: "blog",
  name: "博客主题",
  components: {
    ...builtinTheme.components,
    Chrome,
    Home,
    PostList,
  },
  colorPresets: BLOG_COLOR_PRESETS,
  defaultColorPresetId: BLOG_DEFAULT_COLOR_PRESET_ID,
  colorVarsFromHue,
};
