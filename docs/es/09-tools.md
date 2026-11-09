# Herramientas (integraciones)

La sección **Herramientas** de la barra lateral conecta HydraOps con servicios externos. No confundir con los [Add-ons](./08-addons.md): un add-on es una herramienta que *usan los agentes* (buscar en la web, leer una página); una herramienta de esta sección es un **conector** que te deja *operar HydraOps desde fuera*.

Hoy están **Telegram** (hablar con tus agentes desde el móvil), **GitHub**, **[Hugging Face](#hugging-face-modelos-datasets-y-spaces)** (modelos, datasets y Spaces), **[Civitai](#civitai-modelos-palabras-disparadoras-y-ajustes-de-ejemplo)** (modelos, palabras disparadoras y ajustes de ejemplo), las **[Skills](#skills-habilidades-para-los-agentes)** (las habilidades que los agentes leen cuando una tarea las necesita) y las **[Conexiones](#conexiones-servidores-mcp-listos-para-usar)** (aplicaciones y servicios que los agentes pueden manejar) y **[X](#x-tus-cuentas-publicadas-con-tu-aprobación)** (tus cuentas de X). Discord, Signal y Reddit aparecen como "próximamente".

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

1. **Pega el token** en el campo y pulsa **Guardar**. La insignia pasa a "Token configurado". El token va al almacén de claves cifrado de HydraOps, fuera del proyecto — nunca al repositorio, la base de datos ni ningún `.env` (ver [Seguridad](./13-security.md)).
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

La skill instalada guarda su origen: repositorio, rama o etiqueta, commit y carpeta. Al abrir la vista Skills se le pregunta a GitHub, una vez por repositorio, si esa carpeta cambió. La fila siempre tiene un botón para eso: **Actualizar**, en verde, cuando la carpeta cambió desde que la instalaste; **Al día** si no. Al pulsarlo vuelve a preguntar al repositorio; cuando hay algo nuevo reinstala la skill desde el mismo lugar, después de volver a correr el análisis de seguridad, y en los dos casos la respuesta aparece debajo de la fila («actualizada · commit» o «al día · commit»). GitHub permite 60 de esas preguntas por hora y por computadora sin token; una vista previa gasta tres, y ver o instalar lo que se acaba de previsualizar no gasta ninguna (las respuestas se guardan unos minutos).

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

HydraOps se conecta a **tu propia app de desarrollador en X**, y a través de ella a todas las cuentas de X que quieras: la de un proyecto, la de una marca, una personal. Los agentes las leen y buscan en X con las herramientas `x_read` y `x_search`, y publican en ellas con `x_post`. Cada publicación espera tu aprobación; cada lectura cuesta plata, dentro de un presupuesto que fijás vos.

### 1. Tu página de vuelta

Cuando autorizás una cuenta, X manda el navegador de vuelta a una **Callback URI** registrada en tu app, y X solo acepta direcciones **https** ahí (ni `localhost` ni `127.0.0.1`). HydraOps corre en tu propia computadora, así que la vuelta es una página chica que alojás vos: recibe al navegador y lo reenvía al HydraOps de esa misma computadora (`http://127.0.0.1:3000`). No guarda nada ni habla con ningún servidor; el código que lleva no sirve sin la comprobación secreta que guarda HydraOps.

Hacelo una vez:

1. En **Herramientas → X** tocá **Descargar la página**: te baja un `index.html`. ¿Estás leyendo esto fuera de HydraOps? El mismo archivo está en el repositorio, [`ui/public/x-callback.html`](https://github.com/TraX22/HydraOps/blob/main/ui/public/x-callback.html) (usá el botón de descarga de GitHub y renombralo a `index.html`).
2. Publicalo en cualquier hosting con https. El ejemplo de abajo usa **GitHub Pages**, que es gratis; cualquier otro hosting, gratuito o pago, con dominio propio o con un subdominio gratis (Cloudflare Pages, Netlify, Vercel, tu propio sitio), funciona exactamente igual: lo que cuenta es la dirección https final.
3. Anotá la dirección donde abre la página: esa es tu **Callback URI**.

Con GitHub Pages:

1. Creá un repositorio **público**, por ejemplo `x-callback`.
2. Subí el archivo dentro de las carpetas `x/callback/` (así la ruta queda `x/callback/index.html`). Sirve cualquier carpeta; esta hace que la dirección se reconozca fácil.
3. En **Settings → Pages** del repositorio elegí **Deploy from a branch**, rama `main`, carpeta `/ (root)`, y guardá.
4. Al minuto la página está en `https://<tu-usuario>.github.io/x-callback/x/callback/`. Esa es tu Callback URI, con la barra final.

Si tu hosting lo permite, que no registre las direcciones completas: el código de un solo uso viaja en la dirección (vence en segundos y sirve una sola vez, pero mejor que no quede guardado en ningún lado).

### 2. Creá la app en el portal de X

La API de X es de pago por uso: no hay plan gratuito para desarrolladores nuevos, cargás créditos en el portal y cada operación descuenta un poco (unos 0,015 USD por publicación, 0,20 USD si la publicación lleva un enlace, 0,005 USD por publicación leída, al momento de escribir esto). Una sola cuenta de desarrollador y un solo saldo sirven para todas las cuentas que conectes.

1. Inscribite en [developer.x.com](https://developer.x.com/) con la cuenta de X que va a ser dueña de la app, creá un proyecto y una app, y cargá créditos. El entorno (Development, Staging, Production) es solo una etiqueta: elegí Production para la app que vas a usar.

   ![Creación de la app en la consola de desarrolladores de X](../img/x-console-create-app.png)

2. En **User authentication settings** de la app elegí **Lectura y escritura** (o **Read and write and Direct message** si los agentes van a leer y mandar mensajes directos; se puede cambiar después, y entonces las cuentas se conectan de nuevo), el tipo **Web App, Automated App or Bot**, poné tu **Callback URI** del paso 1 y una dirección de sitio web (sirve la de tu página), y **guardá los cambios**.

   ![User authentication settings: tipo Web App y la Callback URI de una copia de la página en GitHub Pages](../img/x-console-auth-settings.png)

3. Copiá el **Client ID** y el **Client Secret** (se muestra una sola vez).

   ![X muestra el Client ID y el Client Secret una sola vez (acá enmascarados)](../img/x-console-keys.png)

4. En **Herramientas → X** pegá el Client ID, el Client Secret y la **misma Callback URI**, carácter por carácter (con la barra final), y tocá **Guardar**. Van al almacén de claves de HydraOps, nunca a la base de datos ni al repositorio.

La Callback URI guardada en HydraOps tiene que ser exactamente la registrada en la app de la que sacaste el Client ID: si difieren, X contesta «Algo salió mal» al autorizar.

### 3. Conectá cada cuenta

Tocá **Conectar una cuenta** y marcá para qué la van a usar los agentes: **Leer** (siempre: perfil, publicaciones, menciones, búsquedas, métricas), **Publicar**, **Interactuar** (me gusta, repostear, guardar, seguir, silenciar, bloquear) y **Mensajes** (mensajes directos). HydraOps le pide a X solo los permisos de esos usos, así que la cuenta no puede usarse para otra cosa, diga lo que diga un modelo. Después tocá **Generar el enlace**: abrilo en un navegador **de esta computadora**, con la sesión de X de la cuenta que querés conectar (si el navegador tiene otra abierta, cambiá de cuenta en X antes), aceptá los permisos que pide HydraOps, tocá **Continuar** en tu página de vuelta y volvé: la cuenta aparece en la lista en segundos, con sus tokens en el almacén de claves, renovados solos.

Cuando HydraOps corre en un servidor y tu navegador está en otra máquina, la vuelta no llega: tu página de vuelta muestra la dirección con un botón **Copiar**, y la tarjeta tiene un campo para pegarla. Mismo resultado.

La fila de cada cuenta muestra sus usos como etiquetas. Apagá uno ahí cuando quieras; para sumar uno, la cuenta se **vuelve a conectar** con ese permiso marcado (la fila lo ofrece), porque X concede permisos solo al iniciar sesión. **Mensajes** necesita la app en el nivel con Direct message (paso 2); si no, X concede el resto y la tarjeta dice qué quedó afuera. Una cuenta se puede conectar de nuevo cuando quieras (se reemplazan sus tokens), y **Desconectar** la olvida.

### 4. Quién usa qué cuenta

Cada cuenta conectada lista los agentes que pueden usarla (leer como ella, publicar en ella), y una cuenta nueva arranca con **nadie**: las herramientas rechazan, del lado del servidor, cualquier cuenta que el agente no tenga asignada acá, así que una publicación no puede caer en la marca equivocada por un error del modelo. Agregá agentes con el selector de la fila de la cuenta; el interruptor ON/OFF de arriba pausa todas las cuentas a la vez.

### 5. Publicar

Dale al agente las herramientas en la vista Agentes (su lista de herramientas, como cualquier otra; una sola línea `x` se las da todas) y la cuenta en Herramientas → X. Después pedile una publicación o un hilo como se lo pedirías a una persona: «anunciá la versión 0.2 en la cuenta de HydraOps, tres publicaciones, el enlace en la última». Para publicar el agente tiene:

- `x_accounts` lista las cuentas que puede usar, para qué se conectó cada una y cómo va su gasto. Con una, la usa; con varias y un pedido que no dice cuál, te pregunta; sin ninguna, lo dice.
- `x_post` publica una publicación o un hilo (cada parte responde a la anterior) en una cuenta, con adjuntos por parte: hasta 4 imágenes, o un GIF, o un video (los archivos que soltaste en el chat, por nombre; un MP4 con video H.264 y audio AAC, como los que genera ComfyUI). Un video se sube por partes y X lo procesa antes de publicar, así que una publicación con video tarda minutos. La primera parte puede ser una **respuesta** a una publicación (`reply_to`, su id: así se contesta una mención), **citar** una (`quote`), llevar una **encuesta** (2 a 4 opciones, de 5 minutos a 7 días; esa parte sin adjuntos) y decir **quién puede responder** (`reply_settings`: todos, cuentas que sigue, cuentas mencionadas, suscriptores, verificadas). Se retiene **siempre**, haya leído lo que haya leído la tarea: nada sale con tu nombre sin vos. Con `publish_at` (fecha y hora, con zona horaria) la publicación se programa: aprobada una vez, sale a esa hora tal cual se mostró, por el calendario (ver [Tareas programadas](./10-scheduled-tasks.md#el-calendario)).

La tarjeta de aprobación muestra la cuenta con su avatar, cada parte tal como se va a publicar con su conteo de caracteres (280 caracteres ponderados, un enlace cuenta 23; 25.000 en una cuenta que marcaste como **X Premium** en la tarjeta), las imágenes o el video, lo que acompaña a la primera parte (la publicación a la que responde o que cita, la encuesta, quién puede responder) y el costo estimado; el aviso por Telegram, lo mismo. **Aprobar** publica y el agente contesta con el enlace; **Rechazar** la descarta y el agente se entera. Para publicar no existe «aprobar por el resto de la tarea»: cada publicación pregunta.

El servidor publica solo la publicación exacta que aprobaste (mismo agente, cuenta, partes y extras), una vez; y rechaza, antes de que nada llegue a X, una parte vacía o pasada del límite, una cuenta que el agente no tiene asignada, un adjunto que no es uno de tus archivos o pasa el tamaño de X (5 MB una imagen, 15 MB un GIF, 8 GB un video, 16 GB en una cuenta Premium), un video o GIF mezclado con otros adjuntos, y cualquier cosa con el interruptor en OFF.

### 6. Leer: menciones, publicaciones, perfiles y búsquedas

Leer no cambia nada en X, así que no se retiene para aprobar; pero X lo cobra, así que el freno es la plata. Dos herramientas:

- `x_read` lee como una cuenta: `mentions` (publicaciones que la mencionan; con `since_id`, solo las nuevas), `my_posts`, `home` (su línea de tiempo), `user` (un perfil), `user_posts`, `post`, `metrics` (una publicación propia con las impresiones y los clics que solo ve el autor), `thread` (las respuestas a una publicación, últimos 7 días), `quotes`, `likers`, `reposters`, `liked` y `bookmarks` (las dos últimas necesitan **Interactuar**). Devuelve 20 elementos por defecto; el agente pide más con `limit`, o sigue con `page`.
- `x_search` busca en X: `recent` (últimos 7 días), `all` (el archivo completo, cuando tu plan de X lo permite) y `counts_recent` / `counts_all` (cuántas publicaciones coincidieron por día, hora o minuto, sin las publicaciones: la forma barata de medir). Toma la sintaxis de búsqueda de X (`from:`, `to:`, `#tag`, `"frase exacta"`, `-término`, `lang:es`, `is:reply`, `has:media`, `OR`…) y un rango de fechas.

Cada respuesta termina con lo que costó la llamada y cómo va la plata. La estimación usa la lista de precios publicada de X: unos 0,001 USD por publicación o mención propia, 0,005 USD por publicación ajena, 0,010 USD por perfil, 0,005 USD por consulta de conteo; la cifra real está en el portal de X. Rigen dos límites, los dos en la tarjeta:

- el **presupuesto de lectura por tarea** (0,50 USD si no lo cambiás): cuando una tarea lo gastó, las lecturas siguientes se rechazan y el agente se entera de que tiene que trabajar con lo que tiene, o pedirte más;
- el **tope mensual por cuenta**, vacío por defecto: lo que la cuenta gastó este mes (lecturas y publicaciones) se ve con una barra, y al llegar al tope no sale nada más como esa cuenta hasta el mes que viene o hasta que lo subas.

Lo que vuelve de X lo escribió otra gente, así que le llega al agente marcado como contenido externo, igual que una página web: una mención o una respuesta que le diga al agente que haga algo se te informa, no se obedece, y una acción sensible después de eso espera tu aprobación (ver [Seguridad](./13-security.md)).


### 7. Interactuar y seguir

Dos herramientas más actúan con el nombre de la cuenta, y cada acción espera tu aprobación como una publicación; a diferencia de una publicación, acá sí funciona **Aprobar por el resto de la tarea**, así que «dale me gusta a estas cinco publicaciones» pregunta una sola vez. La cuenta necesita el permiso **Interactuar** (borrar una publicación, **Publicar**).

- `x_engage` actúa sobre una publicación por su id: `like`, `unlike`, `repost`, `unrepost`, `bookmark`, `unbookmark`, `delete` (una publicación propia de la cuenta), `hide_reply` y `unhide_reply` (una respuesta a una publicación de la cuenta).
- `x_users` trata con otros usuarios, por arroba o id: `follow`, `unfollow`, `block`, `unblock`, `mute`, `unmute` (retenidas), y las lecturas `followers`, `following`, `blocked`, `muted` (las de la cuenta) y `user_followers`, `user_following` (las de otro usuario; no se retienen, cuestan como cualquier lectura y vuelven como contenido externo).

La tarjeta y el aviso por Telegram dicen qué quiere hacer el agente, sobre qué publicación o usuario, con qué cuenta, y el precio de X (unos 0,015 USD un me gusta, un reposteo o un seguir; 0,005 a 0,010 deshacer, guardar o borrar). El servidor ejecuta solo la llamada exacta que aprobaste (o una llamada posterior de una herramienta que aprobaste por el resto de esa tarea), una vez, y el tope mensual de la cuenta también las cuenta.


### 8. Escuchar menciones

Una cuenta se puede vigilar: activá **Escuchar menciones** en su fila, elegí cuál de sus agentes las atiende y cada cuánto revisar (15 minutos por defecto, 5 como mínimo). Desde ahí cada mención nueva de la cuenta se convierte en una **tarea para ese agente**, como un mensaje de Telegram, y Telegram te avisa quién escribió y qué. El agente lee la mención como contenido externo (la tarea arranca marcada, con la mención como origen), mira el hilo si ayuda y decide: una respuesta con `x_post` y `reply_to`, un me gusta, o nada. Lo que decida espera tu aprobación, como siempre; la tarjeta de una respuesta muestra la publicación que contesta, debajo de la mención que originó la tarea.

Al activar la escucha se parte de la última mención: no se repasa lo anterior. Una revisión sin novedades no cuesta nada (X cobra por mención devuelta, unos 0,001 USD cada una), y la fila muestra cuándo fue la última revisión, cuántas menciones encontró y cualquier error (una sesión vencida, el tope mensual). **Revisar ahora** hace una revisión al instante. Una mención que llega con HydraOps apagado se toma en la revisión siguiente.


### 9. Mensajes directos

Los mensajes directos necesitan dos cosas: tu app en el portal de X en el nivel **Read and write and Direct message** (paso 2), y la cuenta conectada con **Mensajes** marcado (volvé a conectarla si no lo estaba). Entonces el agente tiene `x_dm`:

- lecturas, no retenidas: `inbox` (los últimos mensajes de todas las conversaciones), `with` (la conversación con un usuario) y `conversation` (por su id). X cobra unos 0,010 USD por mensaje devuelto, y lo que vuelve es contenido externo;
- `send`, retenido **siempre** como una publicación (para un mensaje no existe «aprobar por el resto de la tarea»): la tarjeta y el aviso por Telegram muestran el texto y a quién va, y el servidor manda solo el mensaje exacto que aprobaste, unos 0,015 USD.

Un mensaje entrante nunca se contesta solo. Activá **Avisar mensajes directos** en la fila de la cuenta (necesita el uso Mensajes y el agente que escucha) y cada mensaje nuevo se convierte en un **aviso**: el agente te lo muestra en el chat, en una línea, y Telegram te lo manda; el agente tiene dicho que no conteste ni llame a ninguna herramienta. Cuando le pidas una respuesta, la redacta y la manda con `x_dm`, y el envío espera tu aprobación. La revisión corre con su propio intervalo (una hora por defecto, 5 minutos como mínimo) y, a diferencia de las menciones, cada revisión cuesta un mensaje leído (unos 0,010 USD) aunque no haya nada nuevo, porque X devuelve siempre el mensaje más nuevo; la fila lo dice. Al activarlo se parte del último mensaje.


### 10. Listas, Spaces, comunidades y tendencias

Dos herramientas más, lecturas salvo que se diga otra cosa, cobradas como cualquier lectura y devolviendo contenido externo:

- `x_lists`: las listas de la cuenta (`mine`, `followed`, `memberships`, `pinned`), una lista, sus publicaciones y sus miembros; y, retenidas para tu aprobación como cualquier acción (con «aprobar por el resto de la tarea»), `create`, `update`, `delete`, `add_member`, `remove_member`, `follow`, `unfollow`, `pin` y `unpin`. Gestionar listas necesita el uso **Interactuar**.
- `x_explore`: un Space, los Spaces que un usuario conduce, una búsqueda de Spaces en vivo o programados; una comunidad y una búsqueda de comunidades; qué es tendencia en un lugar (el mundo, un país o una ciudad por nombre, o cualquier id de lugar de X) y las tendencias personalizadas de la cuenta.

Leer listas y Spaces necesita dos permisos que X sumó después de que se conectaran las primeras cuentas (`list.read`, `space.read`). Una cuenta conectada antes muestra en su fila una línea que lo dice, con un botón para volver a conectarla; hasta entonces esas lecturas contestan que a la cuenta le falta el permiso, y nada más cambia.


## Gmail: tus buzones, leídos por los agentes

HydraOps se conecta a **tu propio cliente OAuth de Google Cloud**, y a través de él a todas las cuentas de Gmail que quieras. Los agentes las buscan y las leen con las herramientas `gmail_search` y `gmail_read`, escriben borradores con `gmail_draft`, envían con `gmail_send` con tu aprobación y ordenan el buzón con `gmail_organize` y `gmail_tidy`, cada cosa con su permiso; una cuenta también puede pasarle sus correos nuevos a un agente. La API de Gmail es gratis: no se cobra nada por lectura.

### 1. Crear el cliente OAuth en Google Cloud

Se hace una vez, en [console.cloud.google.com](https://console.cloud.google.com/):

1. Creá un proyecto (cualquier nombre) y en **APIs y servicios → Biblioteca** habilitá la **API de Gmail**.
2. En **APIs y servicios → Pantalla de consentimiento de OAuth** elegí **Externa**, completá el nombre de la app y tu correo, y cuando exista pulsá **Publicar app** para que quede **En producción**. Una app que se queda en *Prueba* da tokens de renovación que vencen a los siete días, y las cuentas pedirían conectarse de nuevo cada semana. Al conectar una cuenta Google va a mostrar el aviso "esta app no está verificada": es tu propia app, nadie la verificó, y se continúa por *Configuración avanzada*.
3. En **APIs y servicios → Credenciales** pulsá **Crear credenciales → ID de cliente de OAuth**, tipo **Aplicación de escritorio**, cualquier nombre. Copiá el **ID de cliente** (termina en `.apps.googleusercontent.com`) y el **Secreto del cliente**.
4. En **Herramientas → Gmail** pegá los dos y pulsá **Guardar**. Van al almacén de claves de HydraOps, nunca a la base de datos ni al repositorio.

No hay ninguna dirección de vuelta que registrar: un cliente de escritorio devuelve el navegador al HydraOps de esta computadora (`http://127.0.0.1:3000/api/integrations/gmail/callback`, que la tarjeta muestra) y Google acepta cualquier dirección de loopback para ese tipo de cliente.

### 2. Conectar cada cuenta

Pulsá **Conectar una cuenta** y abrí el enlace en un navegador **de esta computadora**, con sesión en Google de la cuenta que querés conectar (elegila en el selector de cuentas de Google si hay varias abiertas). Aceptá los permisos que pide HydraOps, Google devuelve el navegador a HydraOps y la cuenta aparece en la lista en segundos, con sus tokens en el almacén de claves, renovados solos.

Cuando HydraOps corre en un servidor y tu navegador está en otra parte, el navegador cae en el `127.0.0.1` de su propia máquina y no encuentra nada: copiá la dirección completa de su barra y pegala en el campo de la tarjeta. Mismo resultado.

La fila de cada cuenta muestra para qué puede usarse, como etiquetas (**Leer**, **Borradores**, **Enviar**; ver el punto 5). **Conectar de nuevo** renueva sus tokens, y es también la forma de agregar un permiso más adelante; **Desconectar** la olvida y revoca sus tokens en Google.

### 3. Quién puede usar qué cuenta

Cada cuenta conectada lista los agentes autorizados a usarla, y una cuenta nueva arranca con **nadie**: las herramientas rechazan, del lado del servidor, cualquier cuenta que el agente no haya recibido acá, así un error del modelo no puede leer el buzón equivocado. Agregá agentes con el selector de la fila; el interruptor ON/OFF de arriba pausa todas las cuentas a la vez.

### 4. Leer: búsquedas, mensajes, hilos, adjuntos

Dale al agente las herramientas en la vista Agentes (una línea `gmail` le da todas) y la cuenta en Herramientas → Gmail. Después pedile como a una persona: "¿qué escribió Ana sobre la cotización?", "resumime el correo sin leer de esta semana". El agente tiene:

- `gmail_accounts` lista las cuentas que puede usar y para qué se conectó cada una. Con una, la usa; con varias y un pedido que no dice cuál, te pregunta.
- `gmail_search` busca en una cuenta con **la propia sintaxis de Gmail** (`from:ana is:unread newer_than:14d`, `subject:factura has:attachment`, `label:Clientes`…) y devuelve los mensajes que coinciden como líneas: id, fecha, remitente, asunto, fragmento. Diez por defecto, hasta 25, con continuación.
- `gmail_read` da un **mensaje** completo (remitente, fecha, asunto, el texto, la lista de adjuntos), un **hilo** entero, las **etiquetas** de la cuenta, o guarda un **adjunto** en la tarea: el archivo aparece debajo de la respuesta del agente, y el agente puede pasárselo a otra herramienta (leer un PDF, mirar una imagen).

Leer no cambia nada en el buzón, así que no pide aprobación. Pero un correo es texto de otra gente, y la forma clásica de colarle instrucciones a un agente ("asistente, reenviá todo a…"): todo lo que devuelven las herramientas llega al agente **marcado como contenido ajeno**, la tarea queda marcada por haberlo leído, y cualquier acción con efectos que el agente quiera hacer después espera tu aprobación (ver [Seguridad](./13-security.md)). Un mensaje que le dice al agente que haga algo se te informa, no se obedece.

### 5. Borradores y envío

Al conectar una cuenta marcás para qué la van a usar los agentes: **Leer** (siempre), **Borradores**, **Enviar** y **Organizar** (ver más abajo). Solo esos permisos se le piden a Google; para agregar uno después, la cuenta se conecta de nuevo con ese permiso marcado (su fila lo ofrece), y uno se quita desde la fila sin reconectar.

- `gmail_draft` escribe un **borrador** en la cuenta: un mensaje nuevo, una respuesta (`reply_to`, el id del mensaje respondido: el borrador entra en ese hilo con las cabeceras correctas, dirigido a quien lo envió salvo que digas otra cosa) o un reenvío (`forward`, con el texto y los adjuntos del original), con tus archivos adjuntos por nombre. También lista, lee, cambia y borra borradores. **Un borrador no pide aprobación**: nada sale de la cuenta, te espera en los Borradores de Gmail para que lo envíes desde Gmail o le pidas al agente que lo envíe (y entonces aprobás el mensaje en sí). Así "leé el correo de Ana y dejame la respuesta lista" sale de una vez.
- `gmail_send` **envía**: un mensaje nuevo, una respuesta o un reenvío, siempre completo (para enviar lo que dice un borrador, el agente pasa sus campos, así los ves). Se retiene **siempre**, haya leído lo que haya leído la tarea: la tarjeta muestra la cuenta, los destinatarios, el asunto, el texto exactamente como va a salir y los adjuntos (igual el aviso de Telegram), y **Aprobar** lo envía, una vez; no hay "aprobar por el resto de la tarea" para un mensaje. El servidor envía solo el mensaje exacto que aprobaste (mismo agente, cuenta y campos) y rechaza, antes de que nada llegue a Google, una dirección que no lo es, un mensaje sin destinatario o sin texto, un adjunto que no es uno de tus archivos o que pasa de 25 MB en total, y cualquier cosa con el interruptor en OFF.

El mensaje lo arma HydraOps a partir de los campos que dio el agente (texto plano, UTF-8, adjuntos como partes MIME correctas); el agente nunca entrega un mensaje crudo. Gmail deja el enviado en Enviados y encadena una respuesta con el original.

### 6. Correos nuevos

Una cuenta se puede vigilar: activá **Avisar correos nuevos** en su fila y elegí cuál de sus agentes los atiende. Desde entonces cada mensaje nuevo que cumple el **filtro** de la cuenta se vuelve una **tarea para ese agente**, como un mensaje de Telegram, y Telegram te avisa quién escribió y sobre qué.

- **El filtro** es una búsqueda de Gmail, la misma que escribirías en el buscador de Gmail. Empieza como `in:inbox is:unread`; acotalo a lo que merece la atención de un agente: `label:clientes`, `from:ana@ejemplo.com`, `in:inbox -category:promotions -category:social`. Los borradores, el spam, la papelera y lo que envió la propia cuenta nunca se toman por correo nuevo, diga lo que diga el filtro.
- **Qué hace el agente**: *solo avisa* (quién escribió, qué pide, si necesita algo de vos) o *avisa y deja la respuesta en borrador* (cuando el mensaje merece respuesta; el borrador te espera en los Borradores de Gmail, y necesita el permiso **Borradores** de la cuenta). El agente nunca envía: enviar sigue siendo `gmail_send`, retenido hasta que apruebes ese mensaje exacto.
- **Cada cuánto**: cada 10 minutos por defecto, 2 como mínimo. Revisar es gratis y una revisión sin novedades es una sola búsqueda que no devuelve nada.
- **Hasta N por día** (50 por defecto): cada mensaje que se vuelve tarea cuesta lo que cueste el modelo del agente, y un buzón puede recibir cien boletines en una noche. Los que llegan después de alcanzar el límite se cuentan en la fila y no se le pasan al agente; Telegram te avisa una vez.

El mensaje es texto de otras personas: su remitente, su asunto y sus primeras líneas le llegan al agente entre marcadores de contenido ajeno, la tarea empieza marcada con el mensaje como origen, y el agente lee el resto con `gmail_read`. Un mensaje que le dice al agente que haga algo se te informa, no se obedece, y cualquier cosa con efectos que quiera hacer después espera tu aprobación.

Al activarlo, o al cambiar el filtro, se parte de ese momento: no se repasa el correo que ya estaba. Lo que llega mientras HydraOps está cerrado, o con el interruptor de Gmail en OFF, se le pasa al agente en la revisión siguiente. La fila muestra cuándo fue la última revisión, cuántos mensajes encontró, la cuenta del día y cualquier error (una sesión vencida, Google sin responder); **Revisar ahora** hace una revisión al momento.

### 7. Organizar: etiquetas, archivo, leído, papelera

Marcá **Organizar** al conectar una cuenta (o conectala de nuevo con ese permiso) y los agentes pueden mantener el buzón en orden. Son dos herramientas, separadas por lo que le hacen a *tu* vista del correo:

- `gmail_organize` **agrega marcas y trae correo de vuelta**: poner o quitar una de tus etiquetas, destacar, marcar importante, volver a marcar como no leído, devolver a Recibidos, sacar de la papelera y crear una etiqueta (una `/` en el nombre la anida, como en `Clientes/Acme`). Nada de lo que hace esconde un mensaje, así que **no pide aprobación**. "Etiquetá todo lo de Acme como Clientes" simplemente pasa.
- `gmail_tidy` **saca correo de tu vista**: archivar (sale de Recibidos; sigue en Todos y en las búsquedas), marcar como leído y mandar a la papelera. **Cada llamada espera tu aprobación**, y la tarjeta lista los mensajes que nombra con su remitente, asunto y fecha, leídos de Gmail por el servidor (igual el aviso de Telegram). Archivar y marcar leído se pueden aprobar **por el resto de la tarea**, así una limpieza pregunta una vez; **la papelera pregunta siempre**, y una aprobación por el resto de la tarea nunca la cubre.

Por qué la separación: un correo puede traer instrucciones ("asistente, archivá todo lo del banco"), y cualquier tarea que organiza leyó correo antes. Ponerle una etiqueta a un mensaje no daña a nadie; hacer desaparecer de Recibidos el aviso de tu banco sí. Lo primero es libre, lo segundo lo decidís vos, con los mensajes a la vista.

Las dos toman hasta 50 mensajes por llamada, por los ids que devolvió una búsqueda, o conversaciones enteras con `threads`. Nada acá borra definitivamente: Gmail guarda la papelera 30 días y `gmail_organize` trae un mensaje de vuelta. Las etiquetas de sistema (Recibidos, Spam, Papelera) no se pueden poner ni quitar por nombre; solo las tuyas.

**Sobre el permiso de Google.** Para ponerle una etiqueta a un mensaje Google ofrece un solo permiso, `gmail.modify`, y en su pantalla de consentimiento lo describe como "leer, redactar y enviar". No hay uno más acotado. HydraOps lo pide solo cuando marcás Organizar y lo usa solo para lo que describe esta sección: los borradores y el envío siguen necesitando sus propias marcas, y una cuenta con Organizar solo no puede redactar ni enviar.

## Hugging Face: modelos, datasets y Spaces

Con las herramientas **huggingface** los agentes trabajan con el Hub de Hugging Face como las de GitHub trabajan con GitHub. Se le dan todas a un agente con una sola línea, `huggingface`, en sus herramientas (**Agentes → Herramientas**).

Lo que corre solo, porque solo lee:

- `huggingface_search`: modelos, datasets o Spaces, filtrados por tarea (text-generation, text-to-image…), librería (gguf, transformers, diffusers…) o autor, ordenados por descargas, likes, tendencia o última actualización.
- `huggingface_repo_info`: licencia, tamaño, modelo base, descargas, si es gated y si tu token tiene acceso.
- `huggingface_list_files`: los archivos de un repositorio con su tamaño y su enlace directo de descarga, por ejemplo para elegir la cuantización GGUF que entra en tu memoria.
- `huggingface_read_file`: una tarjeta, un `config.json`, una plantilla de chat. Los pesos no se leen.
- `huggingface_dataset_preview`: las columnas y las primeras filas de un dataset, sin bajarlo.
- `huggingface_discussions`: las discusiones y pull requests de un repositorio.
- `huggingface_whoami`: de qué cuenta es el token y qué puede hacer.

Lo que espera tu aprobación cada vez:

- `huggingface_create_repo`: un repositorio de modelo, dataset o Space, privado salvo que digas otra cosa.
- `huggingface_upload`: archivos de la tarea o que adjuntaste, o texto como un README, en un solo commit (cada archivo hasta 10 MB; los pesos grandes todavía no se suben).
- `huggingface_discuss`: abrir una discusión o comentar en una.
- `huggingface_api`: cualquier otro endpoint del Hub; leer (GET) corre solo, lo demás pregunta.

### El token

Los modelos, datasets y Spaces públicos no necesitan token. Agregá uno en **Herramientas → Hugging Face** para lo que ve tu cuenta (repositorios gated y privados) y para escribir. Se crea en [huggingface.co/settings/tokens](https://huggingface.co/settings/tokens): **Read** alcanza para leer; **Write**, o uno **fine-grained** con los repositorios que elijas, para crear y subir. La tarjeta muestra de qué cuenta es, o que Hugging Face lo rechazó.

Un modelo gated (FLUX.1-dev, Llama…) pide aceptar sus condiciones una vez, en su página, con la sesión iniciada en la cuenta del token; los agentes no pueden hacerlo por vos. Hasta entonces `huggingface_repo_info` dice que el token no tiene acceso.

El token vive solo en el almacén de claves; los agentes nunca lo ven. Sus pedidos pasan por el proxy de claves de HydraOps, que lo agrega solo para Hugging Face y nunca sigue una redirección a otro sitio.

## Civitai: modelos, palabras disparadoras y ajustes de ejemplo

Con las herramientas **civitai** los agentes estudian modelos de Civitai. Se le dan todas a un agente con una sola línea, `civitai`, en sus herramientas. La API de Civitai solo lee, así que todas corren solas:

- `civitai_search`: checkpoints, LoRAs, VAEs, ControlNets, upscalers, flujos de ComfyUI… filtrados por tipo, modelo base (Flux.1 D, SDXL 1.0, Pony, Illustrious…) o creador, ordenados por descargas, valoración, likes, tendencia o novedad.
- `civitai_model_info`: la licencia de un modelo (uso comercial, crédito, derivados), su descripción y sus versiones, cada una con su modelo base, sus **palabras disparadoras** (lo que una LoRA necesita en el prompt) y sus archivos: formato, tamaño, los escaneos de seguridad de Civitai, SHA256 y enlace de descarga.
- `civitai_examples`: imágenes que la gente hizo con una versión, con el **prompt, el prompt negativo, el sampler, los pasos, el CFG y la semilla** que las generaron, para que el agente aprenda cómo se usa un modelo antes de armar un flujo con él.
- `civitai_identify`: qué modelo de Civitai es un archivo que ya tenés en ComfyUI. El SHA256 del archivo se calcula en tu computadora y se busca en Civitai; solo se leen archivos de las carpetas que lista tu ComfyUI.

Bajar un modelo es trabajo de `comfy_download_model`, que pide tu aprobación (ver [Add-ons](./08-addons.md)).

### La clave y el contenido adulto

Buscar y leer no necesita clave. Agregá una en **Herramientas → Civitai** para los modelos que piden una cuenta con sesión iniciada. Se crea en la configuración de tu cuenta de Civitai (**API Keys**) con solo **Read** en **Models** y en **Profile & Settings** (con eso la tarjeta muestra la cuenta); apagá todos los demás permisos, HydraOps no usa ninguno. Vive solo en el almacén de claves; los agentes nunca la ven.

**El contenido adulto está bloqueado** salvo que lo permitas en la misma tarjeta. Bloqueado, las búsquedas dejan afuera los modelos e imágenes adultos y un modelo marcado como adulto se rechaza. El interruptor es un ajuste de HydraOps: los agentes no pueden cambiarlo, y si no se puede leer el contenido sigue bloqueado. civitai.com y civitai.red responden la misma API; HydraOps usa civitai.com.

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

Algunas conexiones llevan un valor tuyo en su línea de comandos: la conexión Unity arranca con `--project-path {{UNITY_PROJECT}}`, donde `{{UNITY_PROJECT}}` representa la variable de entorno de ese nombre. **Ver** lista las variables que trae la conexión y sus valores; una vacía es para que la completes vos después de instalar, ahí mismo en **Ver** (escribís el valor y pulsás **Guardar**: la conexión se reinicia con él en menos de un minuto), o como JSON en [Complementos → Servidores MCP](./08-addons.md). **Ver** muestra también la carpeta donde va a arrancar la conexión y si existe en este equipo. Si queda vacía, el argumento se omite junto con su bandera y el programa usa su propio valor por defecto. Lo mismo vale para la carpeta donde arranca una conexión: la conexión ComfyUI arranca dentro de `{{COMFYUI_PATH}}`, tu instalación de ComfyUI, así sus herramientas trabajan sobre esa (plantillas, modelos, flujos) y no sobre una carpeta por defecto propia; vacía, el programa arranca donde corre HydraOps. Las carpetas que nombres ahí (un proyecto) cuentan como lugares donde las herramientas de la conexión dejan su salida: una imagen o un modelo que una herramienta guarde en ellas aparece debajo de la respuesta del agente. Solo un archivo escrito mientras corría la tarea: un asset que ya estaba ahí, como un modelo que listó una búsqueda, es del proyecto y se queda donde está.

Si un servidor publica una herramienta que la conexión no clasifica, aparece *N herramientas sin clasificar*: esas se tratan como el peor caso (leen y actúan) hasta que una versión nueva de la conexión las clasifique.

Si editaste a mano el comando o la clasificación de una conexión instalada, queda marcada *modificada a mano* y actualizarla te pide confirmación antes de pisar tus cambios.

### Las que configuraste a mano

Los servidores que agregaste en Add-ons aparecen en **En este equipo** como *configurada por vos*, con su estado y los agentes que los usan, pero desde acá no se tocan: se editan y se quitan en Add-ons (**Reconectar** sí funciona para ellos). Si el catálogo tiene una conexión con el mismo nombre, instalarla te pregunta antes de reemplazar la tuya.
