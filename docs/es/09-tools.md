# Herramientas (integraciones)

La sección **Herramientas** de la barra lateral conecta HydraOps con servicios externos. No confundir con los [Add-ons](./08-addons.md): un add-on es una herramienta que *usan los agentes* (buscar en la web, leer una página); una herramienta de esta sección es un **conector** que te deja *operar HydraOps desde fuera*.

Hoy están **Telegram** (hablar con tus agentes desde el móvil), **GitHub** y las **[Skills](#skills-habilidades-para-los-agentes)**, las habilidades que los agentes leen cuando una tarea las necesita. Discord, Signal y Reddit aparecen como "próximamente".

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

Un agente sin `create_skill` no puede crear skills, aunque use las que hay. La tarjeta **Skills** muestra qué agentes tienen cada permiso, y su botón **ON/OFF** apaga las skills para todos.

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
