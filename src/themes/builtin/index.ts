import type { Theme } from "@/modules/theme/types";

import { Checkout } from "./checkout";
import { Chrome } from "./chrome";
import {
  BUILTIN_COLOR_PRESETS,
  BUILTIN_DEFAULT_COLOR_PRESET_ID,
  colorVarsFromHue,
} from "./color-presets";
import { Home } from "./home";
import { Login } from "./login";
import { Me } from "./me";
import { MeOrders } from "./me-orders";
import { PostDetail } from "./post-detail";
import { PostList } from "./post-list";
import { SupporterWall } from "./supporter-wall";
import { Tiers } from "./tiers";

/** 内置主题：Phase 5 的第一个标准主题，作为主题数据契约的参考实现。 */
export const builtinTheme: Theme = {
  id: "builtin",
  name: "内置主题",
  components: {
    Chrome,
    Home,
    PostList,
    PostDetail,
    Tiers,
    Login,
    Me,
    MeOrders,
    Checkout,
    SupporterWall,
  },
  colorPresets: BUILTIN_COLOR_PRESETS,
  defaultColorPresetId: BUILTIN_DEFAULT_COLOR_PRESET_ID,
  colorVarsFromHue,
};
