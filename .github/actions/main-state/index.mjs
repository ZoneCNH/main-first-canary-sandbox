import { resolve } from "node:path";
import { runMainState } from "../../../scripts/lib/main-state.mjs";

const root = resolve(process.env.GITHUB_WORKSPACE ?? process.cwd());
const sha = process.env.INPUT_SHA || process.env.MAIN_SHA || process.env.GITHUB_SHA;
if (!sha) throw new Error("main SHA is required");
if (!process.env.GITHUB_REPOSITORY) throw new Error("GITHUB_REPOSITORY is required");
if (!process.env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN is required");

const result = await runMainState({
  root,
  repository: process.env.GITHUB_REPOSITORY,
  sha,
  token: process.env.GITHUB_TOKEN,
});
console.log(`Main First state: ${result.state}`);
