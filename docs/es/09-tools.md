# Herramientas (integraciones)

La sección **Herramientas** de la barra lateral conecta HydraOps con servicios externos. No confundir con los [Add-ons](./08-addons.md): un add-on es una herramienta que *usan los agentes* (buscar en la web, leer una página); una herramienta de esta sección es un **conector** que te deja *operar HydraOps desde fuera*.

Hoy están **Telegram** (hablar con tus agentes desde el móvil), **GitHub**, las **[Skills](#skills-habilidades-para-los-agentes)** (las habilidades que los agentes leen cuando una tarea las necesita) y las **[Conexiones](#conexiones-servidores-mcp-listos-para-usar)** (aplicaciones y servicios que los agentes pueden manejar) y **[X](#x-tus-cuentas-publicadas-con-tu-aprobación)** (tus cuentas de X). Discord, Signal y Reddit aparecen como "próximamente".

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
2. **Elige un agente predeterminado** (opcional): con él, los mensajes normales van a ese agente sin tener que nombrarlo.
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
| *texto normal* | Va al agente activo (o al agente predeterminado). |
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

### Instalar desde GitHub

Cualquier repositorio público de GitHub que guarde skills en el mismo formato abierto (una carpeta con un `SKILL.md`) también es una fuente: las skills oficiales de Unity, las listas que mantiene la comunidad, un repositorio tuyo. Pegá su dirección en **Instalar desde GitHub** y apretá **Ver qué trae**: el repositorio, una carpeta de él, o el `SKILL.md` mismo (`https://github.com/owner/repo/tree/main/skills/mi-skill`). Todavía no se instala nada: HydraOps lee el repositorio y muestra qué tiene.

- Un repositorio con muchas skills las lista con su descripción, archivos y tamaño; las copias para otros agentes en carpetas ocultas (`.gemini/`, `.codex/`…) quedan afuera, y una skill cuyo nombre ya tenés instalado de otro lado aparece marcada. Elegís las que querés.
- Una sola skill muestra el resumen: nombre, descripción, autor y versión de su `SKILL.md`, la licencia del repositorio y la que declara la skill, los archivos que se instalan y los que no (una imagen, un archivo que supera el límite de tamaño), el **análisis de seguridad**, y un aviso cuando la skill fue escrita para un agente con terminal: en HydraOps el agente traduce esos comandos a las herramientas de sus conexiones, y las que ejecutan código esperan tu aprobación. Podés leer el `SKILL.md` entero antes de confirmar.
- El código fuente que traiga una skill (`.cs`, `.cpp`, `.hlsl`, `.js`…) se instala como **texto de solo lectura**: el agente lo puede abrir como referencia; HydraOps nunca lo compila ni lo ejecuta.

La skill instalada guarda su origen: repositorio, rama o etiqueta, commit y carpeta. Al abrir la vista Skills se le pregunta a GitHub, una vez por repositorio, si esa carpeta cambió; cuando cambió, **Actualizar** la reinstala desde el mismo lugar, después de volver a correr el análisis de seguridad. GitHub permite 60 de esas preguntas por hora y por computadora sin token; una vista previa gasta tres, y ver o instalar lo que se acaba de previsualizar no gasta ninguna (las respuestas se guardan unos minutos).

HydraOps no redistribuye nada: la skill viene del repositorio de su autor, con la licencia que declaran el repositorio y la skill, y la vista previa muestra las dos para que decidas.

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

## Herramientas bajo demanda

Cada llamada al modelo lleva la definición de las herramientas que el agente puede usar, y con un par de conexiones eso son decenas de miles de tokens aunque el pedido sea una línea. Por eso, cuando un agente tiene **más de 12 herramientas**, HydraOps no le manda las definiciones: le manda un índice, con el nombre y una línea por herramienta agrupadas por conexión, y una herramienta más, `load_tools`, con la que el modelo carga la definición completa de las que va a usar en el paso siguiente.

Para que no haga falta esa ronda de carga en los casos obvios, salen cargadas desde el principio:

- las herramientas que nombrás en el mensaje, por el nombre de la conexión ("Blender", "Comfy") o por el nombre de la herramienta ("run workflow");
- las que el mismo chat usó en su tarea anterior;
- las llamadas que una tarea retoma después de una aprobación.

Una herramienta cargada queda cargada por el resto de la tarea, la llame o no: la lista de herramientas es lo primero que va en cada petición, y cualquier cambio en ella hace que el proveedor vuelva a leer toda la conversación a precio completo en vez de desde su caché, que cuesta mucho más que unas definiciones ociosas. La ronda de `load_tools` no cuenta para el límite de pasos del agente. Las aprobaciones, la defensa contra inyección y el baúl de resultados funcionan igual: solo cambia lo que el modelo ve antes de elegir. Qué cargó cada tarea queda en sus datos (`toolsOnDemand`).

Se desactiva en **Configuración → Herramientas bajo demanda** (o con `TOOLS_ON_DEMAND=off`). Con 12 herramientas o menos no cambia nada.

## X: tus cuentas, publicadas con tu aprobación

HydraOps se conecta a **tu propia app de desarrollador en X**, y a través de ella a todas las cuentas de X que quieras: la de un proyecto, la de una marca, una personal. Los agentes van a publicar en ellas, cada publicación esperando tu aprobación (la herramienta de publicar llega en la próxima versión; esta tarjeta es donde se conectan las cuentas y donde decidís quién puede usar cuál).

### 1. Creá la app en el portal de X

La API de X es de pago por uso: no hay plan gratuito para desarrolladores nuevos, cargás créditos en el portal y cada operación descuenta un poco (unos 0,015 USD por publicación, 0,20 USD si la publicación lleva un enlace, 0,005 USD por publicación leída, al momento de escribir esto). Una sola cuenta de desarrollador y un solo saldo sirven para todas las cuentas que conectes.

1. Inscribite en [developer.x.com](https://developer.x.com/) con la cuenta de X que va a ser dueña de la app, creá un proyecto y una app, y cargá créditos.
2. En **User authentication settings** de la app elegí **Lectura y escritura**, el tipo **Web App, Automated App or Bot**, y registrá esta **Callback URI**: `https://hydraops.org/x/callback`. X solo acepta direcciones https ahí; esa página (su fuente está en `deploy/x-callback.html` del repositorio, así que podés alojar tu propia copia) no guarda nada y solo reenvía el navegador al HydraOps de tu computadora.
3. Copiá el **Client ID** y el **Client Secret** (se muestra una sola vez) en **Herramientas → X** y tocá **Guardar**. Van al almacén de claves, nunca a la base de datos ni al repositorio.

### 2. Conectá cada cuenta

Tocá **Conectar una cuenta**: HydraOps muestra un enlace. Abrilo en un navegador **de esta computadora**, con la sesión de X de la cuenta que querés conectar (si el navegador tiene otra abierta, cambiá de cuenta en X antes), aceptá los cuatro permisos (leer tu perfil, publicar, subir imágenes, mantener la sesión) y volvé: la cuenta aparece en la lista en segundos, con sus tokens en el almacén de claves, renovados solos.

Cuando HydraOps corre en un servidor y tu navegador está en otra máquina, la vuelta no llega: la página a la que te manda X muestra la dirección para copiar, y la tarjeta tiene un campo para pegarla. Mismo resultado.

Una cuenta se puede conectar de nuevo cuando quieras (se reemplazan sus tokens), y **Desconectar** la olvida.

### 3. Quién publica dónde

Cada cuenta conectada lista los agentes que pueden publicar en ella, y una cuenta nueva arranca con **nadie**: la herramienta de publicar rechaza, del lado del servidor, cualquier cuenta que el agente no tenga asignada acá, así que una publicación no puede caer en la marca equivocada por un error del modelo. Agregá agentes con el selector de la fila de la cuenta; el interruptor ON/OFF de arriba pausa todas las cuentas a la vez.

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
| `unity` | El [Unity CLI](https://docs.unity.com/en-us/unity-cli/use-unity-cli), el programa de Unity, para la conexión Unity | Lo instala Unity Hub · Windows: `winget install Unity.CLI` · macOS y Linux: `brew install --cask unity-cli` |

El catálogo no acepta ningún otro comando. El botón **Ver** te dice si el lanzador está en tu equipo y, si falta, cómo instalarlo; también lista lo que HydraOps no puede comprobar (por ejemplo, que Blender esté abierto con su add-on activado).

### Instalar y usar

1. En **Herramientas → Conexiones**, tabla **Disponibles**: **Ver** muestra qué necesita, el comando exacto con que se arranca y la clasificación de cada herramienta. **Instalar** la agrega.
2. Dásela a un agente: en **Agentes → Herramientas**, agrega la línea que indica el panel (el nombre de la conexión en minúsculas, por ejemplo `blenderlab`). Ningún agente recibe una conexión que no le diste.
3. El worker de ese agente la conecta solo en unos segundos. La tabla **En este equipo** muestra el estado: *Conectada*, *Sin respuesta · se reintenta sola* (la aplicación estaba cerrada: ábrela, no hace falta reiniciar nada), *Conectada · sin herramientas · se reintenta sola* (el servidor corre pero el programa que maneja no está abierto, el editor de Unity por ejemplo: ábrelo y las herramientas aparecen en menos de un minuto) o *Ningún agente la usa todavía*. **Reconectar** reinicia una conexión en el acto en vez de esperar ese reintento.

Las clases de las herramientas:

| Etiqueta | Clase | Qué pasa |
|---|---|---|
| consulta | `neutral` | Corre libre y no marca la tarea (el estado de tu propia aplicación). |
| lee de afuera | `read` | Corre libre; marca la tarea como que leyó contenido de terceros. |
| modifica | `acts` | Se retiene para tu aprobación si la tarea ya leyó contenido de terceros. |
| lee y modifica | `both` | Las dos cosas. |
| siempre pregunta | `approve` | Cada llamada espera tu aprobación, haya leído lo que haya leído la tarea y con cualquier ajuste de seguridad: código que corre dentro de la aplicación (el `eval` de Unity), un menú que puede hacer cualquier cosa. |

### Versiones y actualizaciones

La versión del programa está **fijada dentro de la conexión** (`uvx comfy-mcp==0.10.0`, `npx @playwright/mcp@0.0.83`): es la que se probó y clasificó. No cambia sola. Cuando el catálogo publica una versión nueva de la conexión, aparece la etiqueta *nueva versión* y el botón **Actualizar**; al actualizar se conservan el interruptor y los valores que hayas cambiado en las variables de entorno (un puerto, por ejemplo).

Algunas conexiones llevan un valor tuyo en su línea de comandos: la conexión Unity arranca con `--project-path {{UNITY_PROJECT}}`, donde `{{UNITY_PROJECT}}` representa la variable de entorno de ese nombre. **Ver** lista las variables que trae la conexión y sus valores; una vacía es para que la completes vos, en [Complementos → Servidores MCP](./08-addons.md), después de instalar. Si queda vacía, el argumento se omite junto con su bandera y el programa usa su propio valor por defecto. Las carpetas que nombres ahí (un proyecto) cuentan como lugares donde las herramientas de la conexión dejan su salida: una imagen o un modelo que una herramienta guarde en ellas aparece debajo de la respuesta del agente. Solo un archivo escrito mientras corría la tarea: un asset que ya estaba ahí, como un modelo que listó una búsqueda, es del proyecto y se queda donde está.

Si un servidor publica una herramienta que la conexión no clasifica, aparece *N herramientas sin clasificar*: esas se tratan como el peor caso (leen y actúan) hasta que una versión nueva de la conexión las clasifique.

Si editaste a mano el comando o la clasificación de una conexión instalada, queda marcada *modificada a mano* y actualizarla te pide confirmación antes de pisar tus cambios.

### Las que configuraste a mano

Los servidores que agregaste en Add-ons aparecen en **En este equipo** como *configurada por vos*, con su estado y los agentes que los usan, pero desde acá no se tocan: se editan y se quitan en Add-ons (**Reconectar** sí funciona para ellos). Si el catálogo tiene una conexión con el mismo nombre, instalarla te pregunta antes de reemplazar la tuya.
