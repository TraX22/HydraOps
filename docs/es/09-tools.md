# Herramientas (integraciones)

La sección **Herramientas** de la barra lateral conecta HydraOps con servicios externos. No confundir con los [Add-ons](./08-addons.md): un add-on es una herramienta que *usan los agentes* (buscar en la web, leer una página); una herramienta de esta sección es un **conector** que te deja *operar HydraOps desde fuera*.

La primera —y por ahora la única— es **Telegram**: hablar con tus agentes desde el móvil. GitHub, Discord, Signal y Reddit aparecen como "próximamente".

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

| Comando | Qué hace |
|---|---|
| `/agents` | Lista los agentes disponibles. |
| `/<agente> <mensaje>` | Envía un mensaje puntual a ese agente (ej. `/elena resume esto`). |
| `/use <agente> [mensaje]` | Fija el agente activo del chat; si añades un mensaje, lo cambia **y** lo envía. |
| *texto normal* | Va al agente activo (o al agente por defecto). |
| `/help` | Muestra la ayuda. |
| `/whoami` | Muestra tu identificador y el agente activo. |

El código responde con marco monoespaciado, así que un "hola mundo" pedido a un agente de código se lee cómodo en el teléfono.

### Control de acceso

Como el bot es alcanzable por cualquiera que conozca su usuario, el acceso se controla con una **lista de autorizados** (los IDs de Telegram que pueden usarlo) más el **código de emparejamiento**. Puedes editar la lista a mano desde la tarjeta —añadir o quitar IDs— y regenerar el código cuando quieras; al regenerarlo, el anterior deja de servir para nuevos emparejamientos.

### Dónde corre el bot

El bot es un servicio más de la pila: arranca con la aplicación de escritorio y con el [modo servidor](./12-server-mode.md). Para que responda a todas horas —desde el móvil, fuera de casa— te interesa tener HydraOps encendido 24/7 en una máquina servidor. Como todos los servicios, aparece en la vista **Sistema** y deja su registro en `storage/logs/telegram-bot.log`.
