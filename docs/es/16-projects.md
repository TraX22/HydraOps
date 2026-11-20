# Proyectos

Un **proyecto** es una carpeta con tu código y un agente que trabaja en él. El agente lee el código, escribe el cambio, y tú ves lo que cambió como un diff. Nada llega a tu carpeta hasta que lo aceptas.

Cada proyecto tiene su pestaña en la sección **Proyectos** de la barra lateral, con tres partes: los archivos del proyecto, el chat con su agente y los cambios que esperan tu decisión.

## Qué necesitas

- **Git** instalado en tu equipo (versión 2.28 o más nueva), con tu nombre y tu correo configurados. La [página Herramientas](./09-tools.md#1-instalar-git) tiene los pasos. Sin Git, la vista Proyectos lo avisa.
- Un **agente**. Sirve cualquiera; en un proyecto recibe las herramientas para los archivos del proyecto además de las suyas.
- **Permiso de escritura en la carpeta del proyecto.** En tu propio equipo lo tienes. Si HydraOps corre como servicio en un servidor, primero hay que listar la carpeta en la unidad del servicio: ver [Modo servidor](./12-server-mode.md#arrancar-solo-al-encender-linux-systemd).

No hace falta permitir la carpeta en Herramientas → Git ni tener un token de GitHub: un proyecto trabaja solo en tu equipo.

## Crear un proyecto

Pulsa **Nuevo proyecto** y completa:

- **Nombre.** Cómo se llama la pestaña.
- **Carpeta.** La ruta completa de la carpeta del proyecto: un repositorio de Git, o una carpeta que contiene varios (por ejemplo `backend` y `frontend`, cada uno un repositorio). Las carpetas de datos y de claves de HydraOps no pueden ser un proyecto.
- **Agente.** Un agente por proyecto.
- **Cargar también la memoria personal del agente.** Apagado por defecto; ver [Notas y memoria](#notas-y-memoria).

Si la carpeta todavía no es un repositorio de Git, la pestaña ofrece convertirla:

- **Con los archivos que hay**: todos los archivos van a un primer commit. Lo que nombra un `.gitignore` queda afuera, así que escribe uno antes si la carpeta tiene dependencias o secretos.
- **Vacío**: el agente arranca de un proyecto vacío y tus archivos quedan como están, sin seguimiento.

## Cómo trabaja el agente

El agente **nunca escribe en tu carpeta**. Por cada repositorio del proyecto, HydraOps guarda una copia propia en una rama llamada `hydraops/<proyecto>`, hecha a partir del commit en el que está tu rama. El agente lee y escribe ahí.

Esto tiene tres consecuencias que conviene conocer:

- **El agente ve lo que está en un commit.** El trabajo que no guardaste en un commit no está en su copia, y tampoco lo que Git ignora: dependencias, compilaciones, archivos `.env`.
- **Sus cambios no corren en tu carpeta.** Tu servidor de desarrollo sigue sirviendo tu versión hasta que aceptes.
- **No puede ejecutar comandos.** Ni compilar, ni correr pruebas, ni instalar nada. Te dice qué ejecutar para comprobar su cambio.

Pide en el chat del proyecto como en cualquier chat: *"agrega un campo `slug` a las notas y úsalo en la lista"*. El agente no pide permiso por cada archivo, porque después decides sobre el cambio completo.

## Revisar, aceptar o descartar

El panel **Cambios** lista cada archivo que el agente cambió, con las líneas agregadas y quitadas. Haz clic en un archivo para ver su diff. Los mismos archivos aparecen marcados en el árbol: **A** agregado, **M** modificado, **D** borrado.

- **Aceptar** guarda los cambios en tu carpeta como **un commit en tu rama**, con tu nombre. El agente propone el mensaje, una línea que dice qué hace el cambio; edítalo o escribe el tuyo. No se envía nada a GitHub: el push sigue siendo de las [herramientas de Git](./09-tools.md#git-commits-ramas-y-envíos-a-github) y de su aprobación.
- **Descartar** tira los cambios y devuelve la copia del agente a tu último commit. También puedes descartar un solo archivo.

Aceptar nunca fuerza nada. Se detiene, y deja los cambios esperando, cuando:

- **Tu rama cambió las mismas líneas mientras tanto.** Descarta los cambios y pídeselo de nuevo al agente; parte de tu última versión.
- **Tu carpeta tiene trabajo sin guardar en los mismos archivos.** Haz un commit de tus cambios o apártalos, y acepta de nuevo.
- **Git no tiene nombre ni correo.** Configúralos una vez (ver [Herramientas](./09-tools.md#1-instalar-git)).

Si tu rama avanzó en *otros* archivos, el commit del agente simplemente se coloca encima.

Al agente se le avisa lo que hiciste. Aceptar, descartar y editar un archivo a mano ocurren fuera de la conversación, así que en su siguiente turno el agente recibe una nota breve: qué archivos quedaron en un commit, qué cambios descartaste y qué archivos editaste. No va a seguir como si un cambio descartado todavía estuviera ahí.

Mientras el agente está trabajando, Aceptar y Descartar esperan a que termine.

Los hooks de Git del repositorio (un lint al hacer commit, por ejemplo) **no corren** en estos commits. Un repositorio puede guardar sus hooks en una carpeta que el agente puede escribir, así que ejecutarlos sería ejecutar lo que el agente escribió.

## Leer y editar el código

Haz clic en un archivo del árbol y se abre en un editor, en una pestaña junto a **Cambios**. Puede haber varios archivos abiertos a la vez.

- **Lo que ves es la copia del agente**: tu último commit más lo que espera ser aceptado. Las líneas que difieren de tu commit llevan una barra a la izquierda.
- **Puedes editar.** Corrige un detalle tú mismo en vez de pedirlo. **Guardar** (o Ctrl+S) escribe tu edición en la copia del agente, donde se suma a los cambios que esperan tu decisión; llega a tu carpeta cuando aceptas, igual que el trabajo del agente. Lo que no guardaste no entra en lo que aceptas, y el panel Cambios te lo recuerda.
- **Mientras el agente trabaja, el archivo es de solo lectura.** Cuando termina, un archivo abierto muestra el texto nuevo por sí solo.
- **Si el agente cambió un archivo que estabas editando**, el guardado se detiene y lo avisa, para que el trabajo de ninguno de los dos se pise sin que lo veas. Tú eliges: cargar la versión del agente, o conservar tu texto y copiar lo que necesites.
- **Cerrar una pestaña con cambios sin guardar pregunta antes.** Ir a otra sección y volver conserva los archivos abiertos y lo que escribiste; recargar la página no.

**Copiar ruta** da la ubicación del archivo en tu propia carpeta, para abrirlo en tu editor de siempre. En la app de escritorio, **Mostrar en la carpeta** abre tu explorador de archivos con el archivo seleccionado; un archivo que el agente creó y todavía no aceptaste no está en tu carpeta, así que muestra la carpeta más cercana que sí existe. Recuerda que tu carpeta tiene tu versión, no los cambios pendientes.

El editor abre archivos de texto de hasta 1 MB. Las imágenes, las compilaciones y otros archivos binarios no se muestran, y los archivos de credenciales (`.env` y sus variantes, claves) no se abren nunca. Las plantillas que un repositorio incluye para mostrar qué variables existen (`.env.example`, `.env.sample`, `.env.template`) son archivos comunes: tú y el agente pueden leerlas y escribirlas, así que no pongas valores reales en ellas.

## Instrucciones: HydraOps.md

`HydraOps.md`, en la raíz de la carpeta del proyecto, guarda las instrucciones del proyecto: cómo se construye y se ejecuta, sus convenciones, qué no tocar. El agente lo recibe en cada mensaje del proyecto. Ábrelo desde la columna izquierda para escribirlo o editarlo.

El agente sigue **solo el texto que aceptaste**:

- Si el archivo vino con la carpeta (un repositorio clonado, la copia de un colega) o cambió por fuera de HydraOps, la pestaña muestra **a revisar** y el agente no lo recibe hasta que lo aceptes.
- Si le pides al agente que escriba o actualice las instrucciones, su propuesta espera tu aprobación en el chat, todas las veces, con el texto completo en la tarjeta.

## Los dos archivos y tus commits

`HydraOps.md` y `ProjectMemory.md` viven en tu carpeta, pero **no forman parte de tus commits**. Cuando la carpeta del proyecto es un repositorio, HydraOps los anota en la lista de exclusión propia del repositorio (`.git/info/exclude`), que queda en tu equipo: tu `.gitignore` no se toca, y un `git add .` los deja fuera.

- **Para versionarlos** (por ejemplo, para compartir las instrucciones con un equipo), abre `.git/info/exclude`, borra las dos líneas con sus nombres y deja la línea de HydraOps que está encima: esa línea le dice a HydraOps que no los vuelva a agregar.
- **Si alguno ya está en el historial de tu repositorio**, ignorarlo no hace que Git deje de seguirlo. La pestaña lo avisa y da el comando: `git rm --cached <archivo>`, y luego un commit. El archivo queda en tu carpeta.

## Notas y memoria

`ProjectMemory.md`, también en la raíz de la carpeta, es donde el agente guarda notas sobre el proyecto: decisiones y sus razones, cómo está hecho algo, qué se probó. Las agrega por su cuenta, y puedes pedírselo: *"anota que la API corre en el puerto 4000"*. Cada mensaje del proyecto lleva estas notas. Puedes leerlas desde la columna izquierda y editar el archivo con cualquier editor.

Las notas le llegan al agente como notas, no como órdenes, y cuentan como contenido de fuera de la aplicación (ver [Seguridad](./13-security.md)): el archivo puede venir con una carpeta clonada.

Por defecto la **memoria personal** del agente, lo que recuerda de su propio chat, no se carga en un proyecto, y "recuerda esto" va a las notas del proyecto. Activa **Cargar también la memoria personal del agente** en los ajustes del proyecto para tener las dos.

## El chat del proyecto es aparte

El chat de un proyecto no es el chat propio del agente. Tiene su historial, y lo que hablas en uno no está en el otro. Así el trabajo largo de un proyecto queda fuera de tus conversaciones de todos los días con el agente, y al revés.

Los comandos con barra también funcionan aquí, incluido `/plan` (ver [Comandos](./15-commands.md)): en modo plan el agente solo lee el proyecto y propone.

## Ajustes y borrado

El engranaje junto al agente abre los ajustes del proyecto: su nombre, su agente y el interruptor de la memoria.

**Borrar el proyecto** quita las copias del agente y su rama. Tu carpeta, sus archivos, los dos archivos del proyecto y el historial del chat quedan. Si todavía hay cambios esperando, al borrar se avisa que se van a perder.

## Seguridad, en breve

- Las herramientas del agente alcanzan solo las copias del proyecto: ninguna otra carpeta, nada de los datos propios de Git, ningún archivo de credenciales, ningún enlace que lleve a otro lado.
- HydraOps no ejecuta nada de lo que el agente escribió.
- Leer código cuenta como leer contenido externo: después, lo que el agente quiera enviar o hacer fuera del proyecto espera tu aprobación, como en cualquier tarea (ver [Seguridad](./13-security.md)).
- Un push siempre espera tu aprobación.
