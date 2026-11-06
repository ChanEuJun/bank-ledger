import type { NextConfig } from "next";

const config: NextConfig = {
  transpilePackages: ["@ledger/core", "@ledger/db"],
  serverExternalPackages: ["pg"],
};

export default config;
