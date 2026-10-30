# PERIL PALS

**Nobody sees the whole truth.**

PERIL PALS is a lethal-cute memory game for one player and an asymmetric cooperative puzzle for 2–8 players. Guide BIMO across a shifting danger grid, recover three signal cores, and escape before the team runs out of lives.

## Run locally

```bash
npm install
npm start
```

Open `http://localhost:3000`. One person can immediately play the complete solo memory challenge. For asymmetric team play, join the same room from a second device or private browser window.

## How to play

### Solo

1. **LOOK:** Memorize the visible dangers and the route to the next core. The first preview is untimed practice; later looks shrink from 6 to 4 seconds.
2. **HIDE:** Press **Ready** (or let the timer expire) and every danger symbol disappears.
3. **RUN:** Use up to two memory markers, then navigate several adjacent moves without seeing the map again. A mistake costs a life.
4. Each signal core is a checkpoint that reveals a reshuffled map. Collect all three cores to unlock the exit, then reach it to win.

### Team

1. Each scout sees one or more private hazard types.
2. Select a dangerous tile and press **Ping danger** to warn every device.
3. The navigator selects one glowing adjacent tile and moves BIMO.
4. Navigator control rotates after each move. Collect all three cores and reach the exit before time expires.

Every generated map has a guaranteed safe route through all three cores to the exit. The server shifts danger tiles while preserving that route.

## Multiplayer architecture

- The Node/Socket.IO server is authoritative for maps, moves, pings, timers, lives, and navigator rotation.
- Each socket receives a personalized game state containing only its assigned hazard types plus hazards already revealed to the team.
- Reconnect support preserves a scout’s role and mission state for 30 seconds.
- Host migration and turn recovery handle disconnects safely.
- Room state is intentionally ephemeral; rooms disappear when the last human leaves or the service restarts.

## Deploy on Render

The included `render.yaml` defines a free Node web service with a `/health` endpoint. Push the project to GitHub, then create a Render Blueprint from the repository. Render will install dependencies and run `npm start`.

## Contest pitch

Most multiplayer games show everyone the same world. PERIL PALS makes synchronization itself the mechanic: each device holds a different piece of the truth. Solo play turns that same hidden-information idea into a tense LOOK–HIDE–RUN memory challenge, so a judge gets a complete game immediately. Checkpoint based memory runs, rotating authority, shifting maps, guaranteed-solvable routes, live pings, and responsive phone controls make the concept easy to demonstrate and hard to master.
