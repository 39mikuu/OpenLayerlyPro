export {
  DEFAULT_LOCALE,
  isLocale,
  type Locale,
  LOCALE_COOKIE,
  LOCALE_NAMES,
  SUPPORTED_LOCALES,
} from "./config";
export type { Messages } from "./messages/zh";
export { negotiateLocale, type Translate, translate } from "./translate";
