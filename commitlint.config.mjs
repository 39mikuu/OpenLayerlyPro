/**
 * Commit message 规范:Conventional Commits 前缀 + 中文描述。
 * 例:feat(config): 新增 SMTP 后台配置项
 * 放宽 subject-case 与 header 长度以容纳中文描述。
 */
const config = {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "subject-case": [0],
    "subject-full-stop": [0],
    "header-max-length": [2, "always", 100],
  },
};

export default config;
