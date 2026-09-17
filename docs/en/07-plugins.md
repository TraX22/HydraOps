# Plugins

**Plugins** is a drawer of mini-apps inside HydraOps. Open it from **Plugins** in the sidebar (above *Tasks*); it shows up as a window without taking you away from what you were doing. Each plugin is a small, focused tool; more will show up over time. Today there are two: **One Shot** and **3D**.

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

## 3D

> 3D is in **beta**.

You describe an object and the model **writes the Three.js code** that builds it; a viewer renders it on the spot and you can orbit it, iterate on it and export it as `.glb` for Unity. Same idea as Claude's 3D tool: there is no mesh generator behind it, just a language model that knows geometry and a canvas that runs what it writes. Everything runs on your machine: Three.js ships inside the app, no internet needed.

### Describe and generate

1. Pick the **model** in the top bar. Anything that writes code works, including your **local model** (1–2 minutes per scene; a cloud one takes 5–15 seconds).
2. Type what you want to see ("a colonial house with a gable roof and a wooden pier") and press **Generate** (or Ctrl+Enter). The object appears centered; drag to orbit, scroll to zoom.
3. Optional: a **reference image**. Upload a photo or one of Luna's sprites and the model looks at it to respect shapes, proportions and colors. Only vision-capable (cloud) models see it; the local one ignores it.

What comes out well: geometric, parametric things — houses, towers, piers, props, simple vehicles. Organic shapes (a horse, a character) come out blocky: that needs a real mesh generator, planned for a later version.

### Iterate and fix

With the scene on screen, type the change ("make the roof red and add a chimney") and **Apply change**: the model gets the previous code and modifies it. If the code it writes fails at runtime, the viewer hands the error back and asks for a fix **up to twice on its own**; the panel shows "asking for a fix (1/2)". If it still fails, you see the error with its line, and you can edit the code by hand in the **Code** tab and **Apply**.

### Export to Unity

**Export .glb** downloads the object as binary glTF, ready to drop into your project's *Assets* folder. Flat-color materials; no textures in this version.

### Saved scenes

**Save** keeps the scene (prompt, code, model, iterations and a thumbnail) under `storage/scenes/` in your data, so it survives clearing the browser and travels with your backup. The panel's list opens and deletes them (with confirmation).

Generated code runs in an **isolated canvas**: it cannot touch the app, your data or your keys.
