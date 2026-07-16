import type { Theme } from "@/modules/theme/types";
import { builtinTheme } from "@/themes/builtin";

import { Chrome } from "./chrome";
import { WORDPRESS_COLOR_PRESETS, WORDPRESS_DEFAULT_COLOR_PRESET_ID } from "./color-presets";
import { Home } from "./home";
import { PostDetail } from "./post-detail";
import { PostList } from "./post-list";
import { SupporterWall } from "./supporter-wall";

/** WordPress 经典主题：主栏 + 侧栏的传统博客阅读形态。 */
export const wordpressTheme: Theme = {
  id: "wordpress",
  name: "WordPress 经典",
  components: {
    ...builtinTheme.components,
    Chrome,
    Home,
    PostList,
    PostDetail,
    SupporterWall,
  },
  colorPresets: WORDPRESS_COLOR_PRESETS,
  defaultColorPresetId: WORDPRESS_DEFAULT_COLOR_PRESET_ID,
};
