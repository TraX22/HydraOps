/**
 * i18n.js — textos del shell de escritorio (menú nativo y ventana Acerca de)
 * en los 5 idiomas de la app. El renderer avisa del idioma elegido por IPC
 * (`ui:lang`); si no llega ninguno, se usa el mismo por defecto que la UI: en.
 *
 * La UI de Angular tiene su propio i18n (ngx-translate); esto cubre solo lo que
 * pinta el proceso principal, que aquél no puede tocar.
 */
const STRINGS = {
  en: {
    menu: {
      updates: "Check for updates",
      reload: "Reload interface",
      devtools: "Developer tools",
      openLogs: "Open logs folder",
      quit: "Quit",
      edit: "Edit",
      undo: "Undo",
      redo: "Redo",
      cut: "Cut",
      copy: "Copy",
      paste: "Paste",
      selectAll: "Select all",
      view: "View",
      resetZoom: "Actual size",
      zoomIn: "Zoom in",
      zoomOut: "Zoom out",
      fullscreen: "Full screen",
      about: "About",
    },
    unavailable: {
      title: "Starting HydraOps…",
      body: "The services are still starting, or the API is not answering.",
      hint: "This page reloads by itself as soon as they are ready. If it stays here, quit HydraOps from the tray and open it again.",
    },
    tray: {
      open: "Open HydraOps",
      closeToTray: "Closing the window keeps HydraOps running",
      launchAtLogin: "Start with Windows",
      startInTray: "Start in the tray (no window)",
      quit: "Quit HydraOps",
      stillRunning: "HydraOps keeps running in the tray. Agents, scheduled tasks and Telegram stay active; use Quit to stop it.",
    },
    about: {
      title: "About HydraOps",
      versionLabel: "Version",
      description:
        "Multi-agent AI task system with a chat interface. Several agents, each with " +
        "its own personality, model and tools, work on tasks in parallel: they write " +
        "code, answer questions, generate images and video.",
      apache: "Free software under the Apache 2.0 license.",
      website: "Website",
      close: "Close",
    },
  },
  es: {
    menu: {
      updates: "Comprobar actualizaciones",
      reload: "Recargar interfaz",
      devtools: "Herramientas de desarrollo",
      openLogs: "Abrir carpeta de logs",
      quit: "Salir",
      edit: "Editar",
      undo: "Deshacer",
      redo: "Rehacer",
      cut: "Cortar",
      copy: "Copiar",
      paste: "Pegar",
      selectAll: "Seleccionar todo",
      view: "Ver",
      resetZoom: "Zoom normal",
      zoomIn: "Acercar",
      zoomOut: "Alejar",
      fullscreen: "Pantalla completa",
      about: "Acerca de",
    },
    unavailable: {
      title: "Iniciando HydraOps…",
      body: "Los servicios todavía están arrancando, o la API no responde.",
      hint: "Esta página se recarga sola en cuanto estén listos. Si se queda aquí, salí de HydraOps desde la bandeja y volvé a abrirlo.",
    },
    tray: {
      open: "Abrir HydraOps",
      closeToTray: "Cerrar la ventana deja HydraOps corriendo",
      launchAtLogin: "Iniciar con Windows",
      startInTray: "Empezar en la bandeja (sin ventana)",
      quit: "Salir de HydraOps",
      stillRunning: "HydraOps sigue corriendo en la bandeja. Los agentes, las tareas programadas y Telegram siguen activos; usá Salir para apagarlo.",
    },
    about: {
      title: "Acerca de HydraOps",
      versionLabel: "Versión",
      description:
        "Sistema multi-agente de IA con interfaz de chat. Varios agentes, cada uno con " +
        "su personalidad, su modelo y sus herramientas, resuelven tareas en paralelo: " +
        "escriben código, contestan preguntas, generan imágenes y vídeo.",
      apache: "Software libre bajo licencia Apache 2.0.",
      website: "Sitio web",
      close: "Cerrar",
    },
  },
  fr: {
    menu: {
      updates: "Rechercher des mises à jour",
      reload: "Recharger l’interface",
      devtools: "Outils de développement",
      openLogs: "Ouvrir le dossier des journaux",
      quit: "Quitter",
      edit: "Édition",
      undo: "Annuler",
      redo: "Rétablir",
      cut: "Couper",
      copy: "Copier",
      paste: "Coller",
      selectAll: "Tout sélectionner",
      view: "Affichage",
      resetZoom: "Taille réelle",
      zoomIn: "Zoom avant",
      zoomOut: "Zoom arrière",
      fullscreen: "Plein écran",
      about: "À propos",
    },
    unavailable: {
      title: "Démarrage de HydraOps…",
      body: "Les services démarrent encore, ou l'API ne répond pas.",
      hint: "Cette page se recharge toute seule dès qu'ils sont prêts. Si elle reste ici, quittez HydraOps depuis la zone de notification et rouvrez-le.",
    },
    tray: {
      open: "Ouvrir HydraOps",
      closeToTray: "Fermer la fenêtre laisse HydraOps actif",
      launchAtLogin: "Démarrer avec Windows",
      startInTray: "Démarrer dans la zone de notification (sans fenêtre)",
      quit: "Quitter HydraOps",
      stillRunning: "HydraOps continue de tourner dans la zone de notification. Agents, tâches planifiées et Telegram restent actifs ; utilisez Quitter pour l'arrêter.",
    },
    about: {
      title: "À propos de HydraOps",
      versionLabel: "Version",
      description:
        "Système de tâches d’IA multi-agent avec une interface de chat. Plusieurs agents, " +
        "chacun avec sa personnalité, son modèle et ses outils, traitent des tâches en " +
        "parallèle : ils écrivent du code, répondent à des questions, génèrent des images et des vidéos.",
      apache: "Logiciel libre sous licence Apache 2.0.",
      website: "Site web",
      close: "Fermer",
    },
  },
  it: {
    menu: {
      updates: "Controlla aggiornamenti",
      reload: "Ricarica interfaccia",
      devtools: "Strumenti di sviluppo",
      openLogs: "Apri la cartella dei log",
      quit: "Esci",
      edit: "Modifica",
      undo: "Annulla",
      redo: "Ripeti",
      cut: "Taglia",
      copy: "Copia",
      paste: "Incolla",
      selectAll: "Seleziona tutto",
      view: "Visualizza",
      resetZoom: "Zoom normale",
      zoomIn: "Ingrandisci",
      zoomOut: "Riduci",
      fullscreen: "Schermo intero",
      about: "Informazioni",
    },
    unavailable: {
      title: "Avvio di HydraOps…",
      body: "I servizi si stanno ancora avviando, oppure l'API non risponde.",
      hint: "Questa pagina si ricarica da sola appena sono pronti. Se resta qui, esci da HydraOps dall'area di notifica e riaprilo.",
    },
    tray: {
      open: "Apri HydraOps",
      closeToTray: "Chiudere la finestra lascia HydraOps in esecuzione",
      launchAtLogin: "Avvia con Windows",
      startInTray: "Avvia nella barra delle applicazioni (senza finestra)",
      quit: "Esci da HydraOps",
      stillRunning: "HydraOps continua a funzionare nella barra. Agenti, attività pianificate e Telegram restano attivi; usa Esci per fermarlo.",
    },
    about: {
      title: "Informazioni su HydraOps",
      versionLabel: "Versione",
      description:
        "Sistema di attività IA multi-agente con interfaccia di chat. Diversi agenti, " +
        "ognuno con la propria personalità, il proprio modello e i propri strumenti, " +
        "elaborano le attività in parallelo: scrivono codice, rispondono a domande, generano immagini e video.",
      apache: "Software libero con licenza Apache 2.0.",
      website: "Sito web",
      close: "Chiudi",
    },
  },
  pt: {
    menu: {
      updates: "Verificar atualizações",
      reload: "Recarregar interface",
      devtools: "Ferramentas de desenvolvedor",
      openLogs: "Abrir pasta de logs",
      quit: "Sair",
      edit: "Editar",
      undo: "Desfazer",
      redo: "Refazer",
      cut: "Recortar",
      copy: "Copiar",
      paste: "Colar",
      selectAll: "Selecionar tudo",
      view: "Exibir",
      resetZoom: "Zoom normal",
      zoomIn: "Aproximar",
      zoomOut: "Afastar",
      fullscreen: "Tela cheia",
      about: "Sobre",
    },
    unavailable: {
      title: "Iniciando o HydraOps…",
      body: "Os serviços ainda estão iniciando, ou a API não responde.",
      hint: "Esta página recarrega sozinha assim que estiverem prontos. Se ficar aqui, saia do HydraOps pela bandeja e abra de novo.",
    },
    tray: {
      open: "Abrir o HydraOps",
      closeToTray: "Fechar a janela mantém o HydraOps rodando",
      launchAtLogin: "Iniciar com o Windows",
      startInTray: "Iniciar na bandeja (sem janela)",
      quit: "Sair do HydraOps",
      stillRunning: "O HydraOps continua rodando na bandeja. Agentes, tarefas agendadas e Telegram seguem ativos; use Sair para encerrá-lo.",
    },
    about: {
      title: "Sobre o HydraOps",
      versionLabel: "Versão",
      description:
        "Sistema multiagente de tarefas de IA com interface de chat. Vários agentes, cada " +
        "um com sua personalidade, seu modelo e suas ferramentas, resolvem tarefas em " +
        "paralelo: escrevem código, respondem perguntas, geram imagens e vídeo.",
      apache: "Software livre sob licença Apache 2.0.",
      website: "Site",
      close: "Fechar",
    },
  },
};

/** Devuelve los textos del idioma pedido; cae a inglés (por defecto de la UI). */
function t(lang) {
  return STRINGS[lang] || STRINGS.en;
}

module.exports = { t, LANGS: Object.keys(STRINGS) };
