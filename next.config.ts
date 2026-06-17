import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["postgres", "sharp", "nodemailer"],
};

export default nextConfig;
