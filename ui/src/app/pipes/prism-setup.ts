// Prism's language component files (prism-typescript.js, prism-csharp.js, …) are
// written against a GLOBAL `Prism`, which a bundler doesn't provide — importing
// them directly throws "Prism is not defined". This module runs first (imported
// before any component) and puts the core instance on the global so the language
// files can extend it.
import Prism from 'prismjs';

(globalThis as unknown as { Prism: typeof Prism }).Prism = Prism;

export default Prism;
