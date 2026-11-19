# Container network allowlist

Date: 2026-11-19. Status: approved by the user ("fais le design et implémente").

## Why

A containerized run (`container: true`, Codex and opencode) has the full network. The agent needs the API of its model,
but its shell can reach any host: it can download code, post the clone somewhere, or read a service on the Docker host.
For Codex this is a step back from the host mode, where `workspace-write` gives its shell no network.

## Goals

- The agent container reaches only the hosts that its CLI needs, on port 443.
- Each run records the connections that the filter refused, so a failed run can be explained.
- A run that needs one more host gets it from the spec, without a code change.

Non-goals: TLS interception, a filter on the host mode, a filter for Claude Code (it does not run in the container).

Anti-goal: a filter that the agent can bypass by ignoring a variable. The network topology enforces the filter, not
`HTTPS_PROXY`.

## Approaches

1. **Internal network and a CONNECT proxy container** (chosen). The agent is on a Docker `--internal` network with no
   route out. A proxy container is on that network and on the default one. The CLIs reach their API through
   `HTTPS_PROXY`. A CLI that ignores the variable gets no network at all: it fails closed.
2. **iptables in the agent container.** Needs `NET_ADMIN`, which the container drops, and filters on IP addresses
   that change behind a CDN.
3. **Squid image as the proxy.** Proven, but a new image and a configuration language for about 60 lines of Node.

The user chose a Node proxy with no dependency, and the npm registry out of the default list.

## Design

- `eval-runner/container/proxy.ts` runs in the agent image (copied by the Dockerfile). It accepts `CONNECT host:443`
  when the host is in `EVAL_PROXY_ALLOW`, and refuses everything else with 403: other ports, IP literals, plain HTTP.
  An entry is a host name, or `*.domain` for the hosts under that domain. It writes one JSON line per decision.
- `eval-runner/container/allow.json` holds the default hosts per agent. The image tag hashes the Dockerfile,
  `proxy.ts` and `allow.json`: a change of the filter gives a new tag, so no cached run from another filter is reused.
- `containerAllow` (spec, only with `container: true`) adds hosts to the default list of the agent.
- Per run, the runner creates the network `<container name>-net` (`--internal`), starts `<container name>-proxy`
  (detached, no capability, read-only, 128 MB), connects it to the network, and waits for its `listening` line. The
  agent container joins the network and gets `HTTPS_PROXY`, `HTTP_PROXY` (both cases) and
  `NO_PROXY=localhost,127.0.0.1`.
- After the agent: the runner removes the agent container, saves `docker logs` of the proxy to `network.log`, removes
  the proxy, then the network. The `finally` block does it again as a backstop. The record gets `blockedHosts`: the
  refused targets. When the proxy stopped before the agent, the record gets a note.

Default hosts, from a spike on 2026-11-19 (each CLI behind the proxy with an empty list):

| Agent | Hosts | Seen refused, not needed |
|---|---|---|
| codex | `chatgpt.com`, `api.openai.com`, `auth.openai.com` | `ab.chatgpt.com`, `*.oaiusercontent.com` |
| opencode | `opencode.ai`, `models.opencode.ai` | `registry.npmjs.org` |

`api.openai.com` serves the API-key login and `auth.openai.com` the token refresh. The spike used the ChatGPT login,
which needed `chatgpt.com` only.

## Limits

- The filter reads the host name of the CONNECT request, not the TLS stream. Domain fronting through an allowed host
  stays possible.
- The gateway of the internal network is the Docker VM. From the agent container, a port published by another
  container (`docker run -p`) is reachable on that address. Services of the Mac itself are not.
- Names do not resolve in the agent container. The proxy resolves them.

## Left to the builder

The wait loop, the error messages, and the names of the helpers.
