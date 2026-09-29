# Lanternfish: Design of a Multi-Region Feature-Flag Service

*An invented design document, used as sample input for the examples. Lanternfish, its teams and its numbers are fictional.*

Status: Approved. Owners: Platform Runtime team. Last reviewed: Q3.

## 1. Overview

Lanternfish serves feature flags and remote configuration to backend services, web clients and mobile apps. It replaces three home-grown systems that drifted apart over the years, each with its own storage, SDK and audit trail.

The service has one job: answer "what value does this flag have for this caller, right now?" in well under a millisecond at the edge, and propagate changes worldwide within seconds.

### 1.1 Background

Today a flag change can take up to fifteen minutes to reach every region, because two of the legacy systems poll a central database. During incidents this delay is the difference between a kill switch and a suggestion.

The legacy systems also disagree on targeting semantics. A percentage rollout of 10% in one system is sticky per user, while in another it is re-rolled on every deploy.

### 1.2 Goals

- Evaluate flags locally in the SDK, with no network call on the hot path.
- Propagate a change to every region in under five seconds at p99.
- One targeting language with deterministic, sticky percentage rollouts.
- A complete audit log: who changed what, when, and why.

### 1.3 Non-goals

- Experiment analysis. Lanternfish assigns variants; the analytics platform measures them.
- Storing secrets. Configuration values are visible to every service that can read the flag.

## 2. Architecture

Lanternfish has a control plane that owns writes and a data plane that serves reads. They share nothing but an append-only change stream.

### 2.1 Components

#### 2.1.1 Control plane

The control plane exposes the admin API and the dashboard. It validates every change, writes it to the primary database, and appends it to the change stream in the same transaction using an outbox table.

#### 2.1.2 Edge relays

Each region runs a fleet of stateless relays. A relay tails the change stream, keeps the full flag set in memory, and pushes updates to connected SDKs over server-sent events.

#### 2.1.3 SDK evaluator

SDKs hold a local copy of the flag set and evaluate rules in-process. They connect to the nearest relay, receive a snapshot on connect, and then apply deltas.

### 2.2 Data model

| Entity | Key | Notes |
| --- | --- | --- |
| Project | `project_id` | Groups flags; owns API keys |
| Environment | `(project_id, env)` | `dev`, `staging`, `prod` |
| Flag | `(project_id, flag_key)` | Type: boolean, string, number, JSON |
| Rule | `(flag_id, position)` | Ordered; first match wins |
| Segment | `(project_id, segment_key)` | Reusable audience definition |
| Change | `change_id` (ULID) | Immutable audit and stream record |

Flags are versioned per environment. Every change increments the environment version, and SDKs report the version they evaluated so support can reproduce any decision.

### 2.3 Consistency

Relays apply changes in stream order and never skip a version. If a relay sees a gap, it drops its state and requests a full snapshot rather than guessing.

Clients are eventually consistent. Two services in different regions can briefly see different versions of a flag; the SDK exposes the version so callers that need read-your-writes can wait for it.

## 3. Targeting

### 3.1 Rule language

Rules match on attributes of the evaluation context: user id, organization, country, app version and any custom attribute a service provides.

```yaml
flag: checkout.new-payment-sheet
rules:
  - if: { segment: internal-staff }
    serve: true
  - if: { attribute: country, in: [PT, ES] }
    rollout: { percent: 25, by: user_id }
  - serve: false   # default
```

### 3.2 Sticky percentage rollouts

A rollout hashes the flag key, a per-flag salt and the chosen attribute with a fixed hash, and maps the result to a bucket from 0 to 9999. Raising a rollout from 10% to 20% keeps everyone who was already in.

```ts
function bucket(flagKey: string, salt: string, id: string): number {
  // 32-bit FNV-1a over "flagKey:salt:id", mapped to 0..9999
  let h = 0x811c9dc5;
  for (const ch of `${flagKey}:${salt}:${id}`) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % 10000;
}
```

### 3.3 Segments

Segments are named audiences that several flags can share. Changing a segment is a change to every flag that references it, and the dashboard shows that blast radius before saving.

## 4. API

### 4.1 Admin endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/projects/{id}/flags` | List flags with their current version |
| `PUT` | `/v1/projects/{id}/flags/{key}` | Create or replace a flag |
| `POST` | `/v1/projects/{id}/flags/{key}/kill` | Serve the off variant everywhere |
| `GET` | `/v1/projects/{id}/changes` | Audit log, newest first |

Every write requires a reason string, which is stored with the change and shown in the audit log.

### 4.2 SDK usage

```ts
const flags = await Lanternfish.connect({ sdkKey: process.env.LANTERNFISH_SDK_KEY });

if (flags.bool("checkout.new-payment-sheet", { userId, country })) {
  renderNewSheet();
}
```

### 4.3 Error handling

If an SDK cannot reach any relay, it keeps serving its last known flag set and retries in the background with exponential backoff. A service that starts with no cached snapshot serves the defaults compiled into its code.

## 5. Rollout plan

### 5.1 Phase 1: shadow mode

Services read from Lanternfish and from their legacy system, serve the legacy value, and report any disagreement. We fix the evaluation differences before any traffic depends on the new system.

### 5.2 Phase 2: read switch

Services serve the Lanternfish value, with the legacy value still computed for comparison. Each team switches with a flag, which is, fittingly, served by Lanternfish.

### 5.3 Phase 3: decommission

Legacy writes are disabled, their data is archived, and the old SDKs are removed from the dependency tree.

## 6. Operations

### 6.1 Metrics

Relays export connected clients, stream lag, snapshot size and delta fan-out time. SDKs export evaluation counts per flag and the age of their flag set.

### 6.2 Alerts

| Alert | Condition | Severity |
| --- | --- | --- |
| Stream lag | Any relay more than 10 s behind for 2 min | Page |
| Stale SDKs | More than 5% of SDKs with a flag set older than 5 min | Page |
| Snapshot size | Snapshot above 8 MB | Ticket |
| Kill switch used | Any `kill` call in `prod` | Notify |

### 6.3 Runbooks

#### 6.3.1 Relay cannot catch up

Check the change stream's retention first. If a relay fell behind the retention window, restart it so it loads a fresh snapshot instead of replaying the stream.

#### 6.3.2 Region isolated

SDKs in an isolated region keep serving their cached flags. Do not fail them over to another region's relays unless the isolation lasts longer than the incident budget allows.

## 7. Security

SDK keys are read-only and scoped to one environment. Admin API calls use short-lived tokens from the company identity provider, and every change is attributed to a person, never to a shared account.

Flag values are not secret. Anything sensitive belongs in the secrets manager, and the control plane rejects values that match known credential patterns.

## 8. Capacity

| Quantity | Today | Planned headroom |
| --- | --- | --- |
| Flags per project | 1,200 | 10,000 |
| Connected SDKs per region | 40,000 | 250,000 |
| Changes per day | 900 | 20,000 |
| Snapshot size | 1.4 MB | 8 MB |

A relay holds every flag in memory and fans out each delta to all its clients, so the fleet size is driven by connections, not by change volume.

## 9. Alternatives considered

### 9.1 Buy a hosted flag service

Hosted services met most goals, but not data residency for two regions, and their pricing scales with monthly active users in a way that punishes our consumer apps.

### 9.2 Evaluate on the server only

A central evaluation API is simpler, but it puts a network call on every request path and makes the flag service a hard dependency of everything.

**Open questions**

- Should mobile SDKs receive the full flag set, or a pre-filtered view per user to reduce payload size?
- How long do we retain the change stream: seven days, or thirty for compliance?

## Appendix A: Glossary

- **Flag set**: every flag of one environment, at one version.
- **Relay**: a data-plane server that streams flag changes to SDKs.
- **Segment**: a named, reusable audience definition.

## Appendix B: Relay configuration

```toml
[relay]
region = "eu-west"
stream = "lanternfish-changes"
max_clients = 50000

[relay.snapshot]
compress = true
max_bytes = 8_388_608
```
