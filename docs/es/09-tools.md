# Herramientas (integraciones)

La sección **Herramientas** de la barra lateral conecta HydraOps con servicios externos. No confundir con los [Add-ons](./08-addons.md): un add-on es una herramienta que *usan los agentes* (buscar en la web, leer una página); una herramienta de esta sección es un **conector** que te deja *operar HydraOps desde fuera*.

Hoy están **Telegram** (hablar con tus agentes desde el móvil), **GitHub**, las **[Skills](#skills-habilidades-para-los-agentes)** (las habilidades que los agentes leen cuando una tarea las necesita) y las **[Conexiones](#conexiones-servidores-mcp-listos-para-usar)** (aplicaciones y servicios que los agentes pueden manejar). Discord, Signal y Reddit aparecen como "próximamente".

## Telegram: manejar los agentes desde el móvil

Con el bot de Telegram le escribes a un agente desde el teléfono y recibes su respuesta, igual que en el chat de la aplicación.

### 1. Crea el bot en Telegram

En Telegram, abre una conversación con **@BotFather** (el bot oficial que crea bots) y envía `/newbot`. Sigue los pasos (un nombre y un usuario que termine en `bot`). Al terminar te da un **token** con esta pinta:

```
123456789:AAF-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

BotFather también te da el enlace a tu bot (`t.me/TuBot`). Guárdalo: es donde escribirás **tú**, no en el chat de BotFather.

### 2. Configúralo en HydraOps

Ve a **Herramientas → Telegram** y:

1. **Pega el token** en el campo y pulsa **Guardar**. La insignia pasa a "Token configurado". El token va a un almacén cifrado fuera del proyecto — nunca al repositorio, la base de datos ni ningún `.env` (ver [Seguridad](./13-security.md)).
2. **Elige un agente por defecto** (opcional): con él, los mensajes normales van a ese agente sin tener que nombrarlo.
3. **Genera un código de emparejamiento** con el botón. Es un número corto que autoriza a quien lo use.
4. **Activa** el interruptor (ON). El bot empieza a escuchar en segundos, sin reiniciar nada.

### 3. Vincula tu teléfono

Abre **tu** bot en Telegram (el enlace `t.me/…` de BotFather) y envía:

```
/start <código de emparejamiento>
```

Si el código coincide, tu cuenta queda autorizada y ya puedes hablar con los agentes. Cualquier persona que no esté autorizada solo puede intentar emparejarse: sin un código válido, el bot no responde a sus mensajes.

### Comandos

El bot usa **los mismos comandos que el chat de la aplicación** (ver [Comandos](./15-commands.md)): `/agents`, `/use <agente>`, `/delegate`, `/tasks`, `/status`, `/remember`, `/recall`, `/crons`, `/cron`, `/pause`, `/resume`, `/run`, `/model`, `/tools`, `/grant`… con sus alias en español. Los que solo tienen sentido con la interfaz (`/oneshot`, `/close`, `/profile`, `/lang`, `/theme`) responden con un aviso.

| Escribes | Qué pasa |
|---|---|
| `/<agente> <mensaje>` | Envía un mensaje puntual a ese agente (ej. `/elena resume esto`) y el bot te devuelve la respuesta. |
| `/use <agente>` | Fija el agente activo de este chat de Telegram. |
| *texto normal* | Va al agente activo (o al agente por defecto). |
| `/help` | Lista todos los comandos. |

El código responde con marco monoespaciado, así que un "hola mundo" pedido a un agente de código se lee cómodo en el teléfono.

### Control de acceso

Como el bot es alcanzable por cualquiera que conozca su usuario, el acceso se controla con una **lista de autorizados** (los IDs de Telegram que pueden usarlo) más el **código de emparejamiento**. Puedes editar la lista a mano desde la tarjeta —añadir o quitar IDs— y regenerar el código cuando quieras; al regenerarlo, el anterior deja de servir para nuevos emparejamientos.

### Dónde corre el bot

El bot es un servicio más de la pila: arranca con la aplicación de escritorio y con el [modo servidor](./12-server-mode.md). Para que responda a todas horas —desde el móvil, fuera de casa— te interesa tener HydraOps encendido 24/7 en una máquina servidor. Como todos los servicios, aparece en la vista **Sistema** y deja su registro en `storage/logs/telegram-bot.log`.

## Skills: habilidades para los agentes

Una **skill** es un procedimiento escrito para un tipo de trabajo: cómo hacer una investigación a fondo, cómo escribir un hilo para X, cómo revisar el SEO de una página. Es una carpeta con un archivo `SKILL.md` (el formato abierto [Agent Skills](https://agentskills.io), el mismo de otros asistentes) y, a veces, archivos de referencia o plantillas.

Las skills son **globales**: se instalan una vez y las usan todos los agentes que tengan permiso. El agente no carga todo el texto en cada tarea: ve solo el nombre y la descripción de cada skill instalada, y abre la que corresponde cuando el pedido encaja. Así el prompt se mantiene corto, algo que se nota con los modelos locales.

### Permisos por agente

Se asignan en **Agentes → Herramientas** de cada agente, como Telegram o la búsqueda web:

| Herramienta | Qué permite |
|---|---|
| `skills` | Ver y usar las skills instaladas. |
| `create_skill` | Proponer skills nuevas. |

Un agente sin `create_skill` no puede crear skills, aunque use las que hay. Los que tienen `create_skill` reciben siempre la guía **skill-creator**, que viene incluida con HydraOps: no se instala ni se puede borrar, y es la que les enseña a escribir una skill en el formato correcto. La tarjeta **Skills** muestra qué agentes tienen cada permiso, y su botón **ON/OFF** apaga las skills para todos.

### Instalar desde el catálogo

La tabla **Disponibles** lee el catálogo oficial, el repositorio público [HydraOps-Skills](https://github.com/TraX22/HydraOps-Skills). Cada skill tiene un botón **Ver** que muestra sus archivos y un **análisis de seguridad** antes de instalarla: avisa si encuentra frases que intentan mandar sobre el agente, nombres de archivos de credenciales, órdenes para descargar y ejecutar algo, texto oculto o algo que parece una clave. **⬇ Instalar** la descarga y comprueba cada archivo contra el índice del catálogo; si no coinciden, no se instala. Cuando el catálogo tiene una versión nueva de una skill instalada aparece **Actualizar**, y **⟳ Buscar novedades** vuelve a consultarlo.

Las skills son texto: HydraOps **nunca ejecuta** los scripts que pueda traer una skill.

### Instalar a mano

También puedes copiar una skill a mano: la carpeta entera (con su `SKILL.md`) dentro de la carpeta de skills de tus datos:

| Instalación | Carpeta |
|---|---|
| Windows (app instalada) | `%APPDATA%\HydraOps\data\skills\` |
| macOS | `~/Library/Application Support/HydraOps/data/skills/` |
| Linux | `~/.config/HydraOps/data/skills/` |
| Desde el código | `skills/` en la raíz del repositorio |

La ruta exacta aparece al pie de la tarjeta. El nombre de la carpeta tiene que coincidir con el `name` del `SKILL.md` (minúsculas, números y guiones). Las skills copiadas a mano aparecen como *copiada a mano* y se borran igual que las demás.

### Skills que crean los agentes

Un agente con `create_skill` puede proponer una skill cuando resolvió algo que vale la pena repetir. La propuesta **no se guarda sola**: queda retenida con una tarjeta **Aprobar / Rechazar** en el chat, en la tabla **Instaladas** (marcada *pendiente de aprobación*) y, si Telegram está configurado, en tu teléfono. Léela entera antes de aprobarla: va a ser instrucciones para todos los agentes que usan skills.

Las skills que crean los agentes se quedan **en tu equipo**: no se suben a ningún repositorio. Un agente tampoco puede modificar ni reemplazar una skill que ya existe.

Por ahora las skills no se editan desde la aplicación: para cambiar una, edita su `SKILL.md` en la carpeta o bórrala y vuelve a instalarla.

## Conexiones: servidores MCP listos para usar

Una **conexión** es un servidor MCP ya configurado: Blender, un navegador real, un conversor de documentos. Es lo mismo que podrías escribir a mano en [Add-ons → Servidores MCP](./08-addons.md), pero con el trabajo hecho: cómo se arranca, qué necesita tu equipo y, sobre todo, **qué hace cada una de sus herramientas** (su [`toolRisk`](./08-addons.md)). Con eso las herramientas que solo leen corren libres y las que modifican algo se retienen para tu aprobación solo cuando corresponde (ver [Seguridad](./13-security.md)), en lugar de que todo pida permiso.

Las conexiones salen del mismo catálogo público que las skills ([HydraOps-Skills](https://github.com/TraX22/HydraOps-Skills), carpeta `presets/`). Una conexión es **configuración, no código**: instalarla escribe una entrada en tu configuración MCP y nada más. El programa del servidor lo publica un tercero y lo trae el lanzador que corresponda.

### Qué necesita cada una

Cada conexión usa el lanzador más liviano que sirva:

| Lanzador | Qué es | Cómo se instala |
|---|---|---|
| `uvx` | Ejecuta programas de Python sin instalarlos (viene con [uv](https://docs.astral.sh/uv/)) | Windows: `winget install astral-sh.uv` · macOS: `brew install uv` |
| `npx` | Ejecuta programas de Node.js (viene con [Node.js](https://nodejs.org/)) | Windows: `winget install OpenJS.NodeJS.LTS` · macOS: `brew install node` |
| `docker` | Solo para servidores que no se publican de otra forma | [Docker Desktop](https://docs.docker.com/get-started/get-docker/) |

El catálogo no acepta ningún otro comando. El botón **Ver** te dice si el lanzador está en tu equipo y, si falta, cómo instalarlo; también lista lo que HydraOps no puede comprobar (por ejemplo, que Blender esté abierto con su add-on activado).

### Instalar y usar

1. En **Herramientas → Conexiones**, tabla **Disponibles**: **Ver** muestra qué necesita, el comando exacto con que se arranca y la clasificación de cada herramienta. **Instalar** la agrega.
2. Dásela a un agente: en **Agentes → Herramientas**, agrega la línea que indica el panel (el nombre de la conexión en minúsculas, por ejemplo `blender`). Ningún agente recibe una conexión que no le diste.
3. El worker de ese agente la conecta solo en unos segundos. La tabla **En este equipo** muestra el estado: *Conectada*, *Sin respuesta · se reintenta sola* (la aplicación estaba cerrada: ábrela, no hace falta reiniciar nada) o *Ningún agente la usa todavía*.

Las clases de las herramientas:

| Etiqueta | Clase | Qué pasa |
|---|---|---|
| consulta | `neutral` | Corre libre y no marca la tarea (el estado de tu propia aplicación). |
| lee de afuera | `read` | Corre libre; marca la tarea como que leyó contenido de terceros. |
| modifica | `acts` | Se retiene para tu aprobación si la tarea ya leyó contenido de terceros. |
| lee y modifica | `both` | Las dos cosas. |

### Versiones y actualizaciones

La versión del programa está **fijada dentro de la conexión** (`uvx mcp-for-blender==2.1.3`, `npx @playwright/mcp@0.0.83`): es la que se probó y clasificó. No cambia sola. Cuando el catálogo publica una versión nueva de la conexión, aparece la etiqueta *nueva versión* y el botón **Actualizar**; al actualizar se conservan el interruptor y los valores que hayas cambiado en las variables de entorno (un puerto, por ejemplo).

Si un servidor publica una herramienta que la conexión no clasifica, aparece *N herramientas sin clasificar*: esas se tratan como el peor caso (leen y actúan) hasta que una versión nueva de la conexión las clasifique.

Si editaste a mano el comando o la clasificación de una conexión instalada, queda marcada *modificada a mano* y actualizarla te pide confirmación antes de pisar tus cambios.

### Las que configuraste a mano

Los servidores que agregaste en Add-ons aparecen en **En este equipo** como *configurada por vos*, con su estado y los agentes que los usan, pero desde acá no se tocan: se editan y se quitan en Add-ons. Si el catálogo tiene una conexión con el mismo nombre, instalarla te pregunta antes de reemplazar la tuya.
