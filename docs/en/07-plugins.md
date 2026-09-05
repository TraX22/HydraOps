# Plugins

**Plugins** is a drawer of mini-apps inside HydraOps. Open it from **Plugins** in the sidebar (above *Tasks*); it shows up as a window without taking you away from what you were doing. Each plugin is a small, focused tool; more will show up over time. Today there's one: **One Shot**.

## One Shot

> One Shot is in **beta**.

Writing a good prompt is hard: you ramble, you forget pieces, you don't know where to start. One Shot flips it around: **you draw the task as a flow diagram** — boxes of text joined by arrows — and HydraOps, using the model you already have configured, **compiles it into a single, clean, self-contained "one-shot" prompt**, ready to send.

The diagram captures the **logic** of what you want (where the input comes from → steps → decisions → what it should deliver), not its "sections". No need to write prose: just think it out in boxes.

### Drawing the diagram

- **Add node** creates a box with a **title** and a **body**, both editable. Write the piece each one stands for.
- **Icon and color**: click the node's icon to pick another, and tap the node then a color from the **palette** in the right panel (vivid on top, pastel below) to paint its title bar. The same color again clears it; with no node touched, the chosen color applies to the nodes you create from then on.
- **Connect** two nodes: drag from the edge of one to the other. Each node has a connection point per side, the arrow picks which side to leave from, and as many arrows as you need can leave the same point.
- **Re-route** an arrow: click it to select it, then drag one of its endpoints onto another node.
- **Delete** an arrow: click it to select it and press **Delete** (or the delete button that appears).
- Drag nodes to arrange them; the controls at the bottom handle **zoom** and **fit to screen**, and there's a minimap.

### Compiling and using the prompt

1. Pick the **agent** (it decides which model compiles the diagram).
2. Hit **Compile**. The diagram travels to the model — the key is injected by the key-proxy, just like any task — and the written prompt comes back.
3. With the result, **Copy** it to the clipboard or **Send to chat**: that opens the agent's channel with the prompt already in place, as just another task. See [Chat](./06-chat.md).

### Diagram history

Each diagram **autosaves** as you work, under a name you can edit. The right-hand panel lists your diagrams, most recent first; from there you create a new one, open another, or delete it (with a confirmation, so a stray click can't discard your work). Everything is stored in your browser, on this machine.
