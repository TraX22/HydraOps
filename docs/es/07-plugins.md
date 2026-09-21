# Complementos

**Complementos** es un cajón de mini-aplicaciones dentro de HydraOps. Se abre desde **Complementos** en la barra lateral (encima de *Tareas*) y aparece como una ventana, sin salir de donde estabas. Cada complemento es una herramienta pequeña y enfocada; irán apareciendo más con el tiempo. Hoy hay dos: **One Shot** y **3D**.

## One Shot

> One Shot está en **beta**.

Dar un buen prompt es difícil: uno se enreda, se olvida piezas, no sabe por dónde empezar. One Shot le da la vuelta: **dibujas la tarea como un diagrama de flujo** —cajas con texto, unidas por flechas— y HydraOps, con el modelo que ya tienes configurado, lo **compila en un único prompt "one-shot"** limpio y autocontenido, listo para enviar.

El diagrama representa la **lógica** de lo que quieres (de dónde sale la información → pasos → decisiones → qué debe entregar), no sus "secciones". No hace falta redactar: basta con pensarlo en cajas.

### Dibujar el diagrama

- **Añadir nodo** crea una caja con un **título** y un **cuerpo** de texto, los dos editables. Escribe en cada una la pieza que representa.
- **Icono y color**: haz clic en el icono del nodo para elegir otro, y toca el nodo y luego un color de la **paleta** del panel derecho (vivos arriba, pasteles abajo) para pintar su barra de título. El mismo color otra vez la despinta; sin ningún nodo tocado, el color elegido se aplica a los nodos que crees a partir de ahí.
- **Conectar** dos nodos: arrastra desde el borde de uno hasta el otro. Cada nodo tiene un punto de conexión por lado, la flecha elige sola por dónde salir, y de un mismo punto pueden salir tantas flechas como necesites.
- **Re-rutear** una flecha: haz clic sobre ella para seleccionarla y arrastra uno de sus extremos hasta otro nodo.
- **Borrar** una flecha: haz clic sobre ella para seleccionarla y pulsa **Supr** (o el botón de borrar que aparece).
- Arrastra los nodos para acomodarlos; abajo tienes los controles de **zoom** y **encajar a pantalla**, y un minimapa.

### Compilar y usar el prompt

1. Elige el **agente** (define qué modelo compila el diagrama).
2. Pulsa **Compilar**. El diagrama viaja al modelo —la clave la inyecta el key-proxy, igual que en cualquier tarea— y vuelve el prompt ya redactado.
3. Con el resultado, **Copiar** al portapapeles o **Enviar al chat**: esto abre el canal del agente con el prompt ya puesto, como una tarea más. Ver [El chat](./06-chat.md).

### Historial de diagramas

Cada diagrama se **guarda solo** mientras trabajas, con un nombre que puedes editar. El panel de la derecha lista tus diagramas, el más reciente arriba; desde ahí creas uno nuevo, abres otro o lo borras (con confirmación, para no perder trabajo de un clic). Todo se guarda en tu navegador, en este equipo.

## 3D

> 3D está en **beta**.

Describís un objeto y el modelo **escribe el código Three.js** que lo construye; un visor lo renderiza al instante y podés girarlo, iterar sobre él y exportarlo a `.glb` para Unity, Unreal, Blender o tu aplicación 3D favorita. Es la misma idea que la herramienta 3D de Claude: no hay un generador de mallas detrás, hay un modelo de lenguaje que sabe geometría y un lienzo que ejecuta lo que escribe. Todo corre en tu máquina: Three.js viaja dentro de la aplicación, sin internet.

### Describir y generar

1. Elegí el **modelo** en la barra superior. Sirve cualquiera que escriba código, incluido tu **modelo local** (tarda 1 o 2 minutos por escena; uno de nube, entre 5 y 15 segundos).
2. Escribí qué querés ver ("una casa colonial con techo a dos aguas y un muelle de madera") y pulsá **Generar** (o Ctrl+Enter). El objeto aparece centrado; arrastrá para girarlo, rueda para acercar.
3. Opcional: **Estilo** y **Mejorar prompt**. El selector de estilo (Libre, Low-poly, Vóxel, Prop de juego, Realista) fija la estética de la escena y se guarda con ella. **Mejorar prompt** convierte una idea corta ("un cofre del tesoro") en una descripción con tamaño, partes principales, detalles y paleta; la ves en la caja, la retocás si querés y recién ahí generás. **Deshacer** vuelve a tu texto original. Usa el mismo modelo elegido y ayuda sobre todo a los modelos medianos y al local.
4. Opcional: **imagen de referencia**. Subí una foto o un sprite de Luna y el modelo la mira para respetar formas, proporciones y colores. Solo la ven los modelos con visión, los de nube; el local la ignora.

El modelo no escribe Three.js "a pelo": recibe un kit de ayudas (cajas, cilindros, torneado de perfiles, extrusión de siluetas, espejo, repetición en anillo o grilla, materiales compartidos) y un método de trabajo (silueta primero, luego partes medias, luego detalles; paleta de 3 a 5 colores; sin caras superpuestas). Eso es lo que hace que el primer resultado ya tenga forma.

Lo que sale bien: cosas geométricas y paramétricas, casas, torres, muelles, props, vehículos simples. Lo orgánico (un caballo, un personaje) sale como bloques: eso pide un generador de mallas real, que queda para una versión futura.

Mientras el modelo trabaja, el cartel de arriba a la izquierda muestra el tiempo transcurrido y un botón **Cancelar**: corta la llamada al modelo en el acto (útil con razonadores que tardan minutos) y deja tu texto como estaba.

### Iterar y corregir

Con la escena en pantalla, escribís el cambio ("hacé el techo rojo y agregale una chimenea") y **Aplicar cambio**: el modelo recibe el código anterior y lo modifica. Si el código que escribe falla al ejecutarse, el visor le devuelve el error y le pide la corrección **hasta dos veces solo**, sin que hagas nada; el panel muestra "pidiendo corrección (1/2)". Si aun así falla, ves el error con la línea, y podés retocar el código a mano en la pestaña **Código** y **Aplicar**.

### Exportar a Unity, Unreal, Blender…

**Exportar .glb** descarga el objeto en glTF binario, el formato estándar que abre casi cualquier herramienta 3D. En **Blender** se importa con *Archivo → Importar → glTF 2.0*. En **Unreal Engine 5** se arrastra al Content Browser (el importador de glTF viene incluido). En **Unity** hace falta el paquete oficial *glTFast* (`com.unity.cloud.gltfast`, desde el Package Manager); con él instalado, el `.glb` se arrastra a la carpeta *Assets* como cualquier otro modelo. Cada parte conserva su nombre y su grupo. Materiales de color plano; sin texturas en esta versión.

### Escenas guardadas

**Guardar** conserva la escena (prompt, código, modelo, iteraciones y una miniatura) en `storage/scenes/` de tus datos, así que sobrevive a limpiar el navegador y va con tu copia de seguridad. La lista del panel las abre y las borra (con confirmación).

El código generado corre en un **lienzo aislado**: no puede tocar la aplicación, tus datos ni tus claves.
