# RP5 evidence: CI gate for active release branch

日期：2026-09-21
基线：`HEAD=8d616c0`（工作区另有未提交恢复切片）
任务：RP5（INTEGRATOR，见 `docs/superpowers/plans/opening-release/12-review-hardening.md`）

## 完成项

1. `push` 触发分支增加 `feat/opening-release`；新增 `workflow_dispatch` 手动入口（`.github/workflows/ci.yml`）。
2. `docs/operations/ci.md` 更新触发范围、发布证据绑定 SHA 的要求、minio 镜像现状说明。

## 镜像可拉取性核查（Docker Hub / quay API，非本机 docker pull——本机无 Docker CLI）

| 镜像 | 结果 |
|---|---|
| `bitnami/minio:2025.4.22`（CI 原引用） | Docker Hub API 404；`bitnami/minio` 仓库活跃但已无可拉取 tag（Bitnami 2025-08 将旧版迁入 legacy namespace） |
| `minio/minio:RELEASE.2025-04-22T22-12-26Z`（compose 引用） | Docker Hub API 404；`minio/minio` 仓库整体不在 Docker Hub；quay.io/minio/minio 最新仅到 2022-02 旧版 |
| `bitnamilegacy/minio:2025.4.22-debian-12-r2` | 存在，含 linux/amd64 image，last_pulled 2026-09-21（活跃）；已写入 ci.yml |
| `quay.io/minio/minio:RELEASE.2025-04-22T22-12-26Z` | manifest v2 存在（匿名 token 拉取成功）；已写入 `infra/docker/compose.yml` |
| `quay.io/minio/mc:RELEASE.2025-04-16T18-13-26Z` | manifest v2 存在（匿名 token 拉取成功）；已写入 `infra/docker/compose.yml` |
| `postgres:16-alpine`、`redis:7-alpine` | 未在本轮 API 复核（Docker Hub library 镜像，CI 历史 run 可拉取） |

## 未完成/后续

- **pending**：当前 HEAD push 后 `quality` job 的实际运行链接与结果——需 push 生效后补记（本地改动未提交，未 push）。
- GitHub Actions service container 对 `bitnamilegacy` 的拉取、以及本地 `compose:up` 对 quay.io 的匿名拉取，均以实际运行结果为准；本证据只证明 registry 侧 manifest 存在。
- GitHub Actions service container 拉取行为以实际 run 为准；本证据只证明 registry 侧对象存在。
