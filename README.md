# Main First Canary Sandbox

隔离 repo 用于 Main First state machine live synthetic canary（C-22/C-23 方案 B）。

## 用途

- 验证 `main-first/state` 状态机在隔离环境的实际行为
- 验证 duplicate required check → FROZEN + Incident 创建
- 验证 GREEN recovery → Incident close + recovery comment

## 与 xhyperium/xhyper.rs 的关系

- **不**是 xhyper.rs 的 Main First 证据源
- 仅证明代码路径（`scripts/lib/main-state.mjs`）在隔离环境可工作
- 真实 Production Enforced 仍以 `xhyperium/xhyper.rs` 的 #620 Promotion 为准

## 配置

- `required_checks`: 仅 `fmt`（简化）
- `runner`: `ubuntu-latest`
- `main-first-governance.yml`: workflow_run trigger on CI completion
- `ci.yml`: push trigger，单 fmt job
