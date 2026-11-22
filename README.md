# Rooftop Rumble

Turn-based rooftop artillery for 1 to 4 players. Raccoons throw exploding soda cans across a randomly built city. Wind changes each round, and blasts knock holes in the buildings.

```sh
npm install
npm start          # http://localhost:8080, set PORT to change it
npm run typecheck
```

Needs Node 23.6 or newer. The server strips TypeScript types on the fly, so there's no build step.

## Playing

- **Local**: up to 4 seats, each Human, CPU (easy/normal/hard) or Off. Turn on Teams for co-op, e.g. two humans against two CPUs.
- **Online**: create a room and share the 5-letter code or link. The host can add CPUs. One browser can claim several seats, so couch and online players can mix. If someone drops mid-match, a CPU takes over their raccoon.

Controls on your turn:

| Input | Aim | Power | Throw |
| --- | --- | --- | --- |
| Mouse | drag to adjust your last shot (slingshot by default, switch to "point" in the menu), Shift for fine | same drag | release, or just click to repeat the last shot |
| Gamepad | left stick left/right (push further to turn faster), d-pad left/right for 0.5° steps | right stick up/down, d-pad up/down for 1% steps | A |
| Keyboard | ← → | ↑ ↓ (hold Shift for fine steps) | Space / Enter |

Esc or the gamepad Start button opens the menu. Each seat can be tied to one gamepad, or "Any pad" for hot-seat play.

## Docker

CI publishes an image to `ghcr.io/skint007/rooftop-rumble` on every push to `main` (`latest` and `sha-<commit>`) and for version tags (`v1.2.3` gives `1.2.3` and `1.2`).

```sh
docker run --rm -p 8080:8080 ghcr.io/skint007/rooftop-rumble:latest
```

`compose.yaml` is an example deployment with a read-only filesystem and small resource limits. Rooms live in memory, so restarting the container ends any running matches. Online play uses a WebSocket at `/ws`, so a reverse proxy in front of it has to allow WebSocket upgrades.

To cut a release, bump `version` in `package.json`, merge, then tag that commit `v<version>` and push the tag.

## Layout

- `src/shared/game.ts` holds the rules: city generation, throw physics, damage, CPU aiming. Pure functions, used by both sides.
- `src/shared/match.ts` runs turns, CPU moves and rounds. The browser runs it for local games, the server for online rooms.
- `src/server/` serves files and hosts WebSocket rooms. The server is authoritative online, clients only send aim and throw.
- `src/client/` has drawing, input, synthesized sound and the menus.
