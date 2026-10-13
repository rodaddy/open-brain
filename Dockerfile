# =============================================================================
# Open Brain — container image for the k3s app-delivery rail (issue 762).
#
# STATUS: WRITTEN. Nothing here has been built and nothing is running.
#
# THIS FILE IS BUILT IN THE CLUSTER, NOT ON A WORKSTATION.
#
# The reference deployment builds it with an in-cluster Kaniko Job using a git
# build context pinned to a 40-character commit sha, e.g.
# `--context git://git.example.internal/you/open-brain.git#<40-char-sha>`.
#
# Kaniko implements the CLASSIC builder, so BuildKit-only syntax fails
# in-cluster after a clone and a base pull — a slow way to learn it. This file
# therefore contains NO `RUN --mount=type=cache`, NO `RUN --mount=type=secret`
# and NO heredocs. `COPY --from` between stages is fine and is used below.
# Layer caching is real but remote (`--cache-repo`), so dependency manifests
# go on their own layer ahead of source.
#
# RUNTIME: Node 24.13.1 Alpine. The source and lockfile are installed by npm,
# and Node executes the TypeScript entrypoint directly.
# =============================================================================

# -----------------------------------------------------------------------------
# STAGE 1 — build
#
# PINNED, never `:latest`. A rebuild months from now must produce the same
# image; a base that silently moves is a build whose failures cannot be
# bisected.
# -----------------------------------------------------------------------------
FROM docker.io/library/node:24.13.1-alpine AS build

WORKDIR /src

# Dependency manifests FIRST, on their own layer. Source churns far more often
# than dependencies, so this ordering is what makes the remote cache pay.
COPY package.json package-lock.json .npmrc .node-version ./
RUN npm ci

# Source after dependencies.
COPY . .

# -----------------------------------------------------------------------------
# STAGE 2 — runtime
#
# Same pinned Node base. The app is TypeScript executed directly by Node (see
# package.json `start`: `node --env-file-if-exists=.env server/main.ts`), so there is no compiled
# artifact to copy out — what the split buys here is that the build stage's
# install scratch and any build-time state stay out of the runtime layer.
# -----------------------------------------------------------------------------
FROM docker.io/library/node:24.13.1-alpine

# -----------------------------------------------------------------------------
# IDENTITY — a numeric non-root uid/gid in the 5000-5999 first-party band.
#
# THE POD SETS `runAsNonRoot: true`. An image with no USER line does not fail
# at build time — it fails at POD START with "container has runAsNonRoot and
# image will run as root", after a successful build, push and pull. That is the
# slowest possible place to find a one-line omission (rail:636-643).
#
# 5040 is written as a LITERAL, not `${APP_UID}`: an ARG-expanded USER is legal
# Dockerfile and works in both builders, but it defeats every static check —
# including scripts/done-means/762-k3s-manifests.sh, which cannot distinguish
# `USER ${APP_UID}` from a default that resolves to root.
#
# This value MUST equal the Deployment's runAsUser/runAsGroup/fsGroup. When
# they disagree the manifest wins and the ownership baked in below becomes
# wrong — the app runs as a uid that does not own the directories it writes.
# -----------------------------------------------------------------------------
RUN addgroup -g 5040 -S app \
 && adduser -u 5040 -G app -S -H -s /sbin/nologin app

# -----------------------------------------------------------------------------
# WRITABLE PATHS — real, named, owned here, and NOT /tmp.
#
# In a container /tmp is backed by the node's ephemeral storage with no ceiling
# unless one is given, so a runaway intermediate file fills the NODE and evicts
# unrelated pods (rail:644-651). The Deployment mounts a BOUNDED emptyDir over
# /var/lib/app/scratch and the ConfigMap points the app at it; the three names
# must stay in step.
# -----------------------------------------------------------------------------
RUN mkdir -p /var/lib/app/data /var/lib/app/scratch \
 && chown -R 5040:5040 /var/lib/app

WORKDIR /var/lib/app

COPY --from=build --chown=5040:5040 /src /var/lib/app/

# Numeric, literal, and matching the Deployment's securityContext.
USER 5040:5040

# -----------------------------------------------------------------------------
# PORT — 3100, the port this app already serves on.
#
# NOT 3000: that is a hard fleet ban (rail:706-711), grandfathered only for
# Forgejo's own git.example.internal. EXPOSE is documentation; the Deployment's
# containerPort is what the Service targets, and the two are kept equal.
# The app must bind 0.0.0.0 (set via OPEN_BRAIN_BIND_HOST in the ConfigMap),
# never 127.0.0.1 — a loopback bind passes every local test and then serves
# nobody, because the probe and the Service both dial the pod IP.
# -----------------------------------------------------------------------------
EXPOSE 3100

# -----------------------------------------------------------------------------
# HEALTH — the app serves /healthz (liveness, no dependency I/O) and /readyz
# (readiness, cheap bounded dependency check). Kubernetes runs its own probes
# from the Deployment and ignores an image HEALTHCHECK, so none is declared.
# -----------------------------------------------------------------------------

# -----------------------------------------------------------------------------
# ROLE — one image, two processes (issue 1594). server/entry.ts reads
# OPEN_BRAIN_ROLE: unset or `server` runs server/main.ts's main(); `nats-worker`
# runs scripts/run-nats-worker.ts (copied above with the rest of /src); any
# other value exits 2 with the allowed set on stderr.
# -----------------------------------------------------------------------------
ENTRYPOINT ["node", "server/entry.ts"]
