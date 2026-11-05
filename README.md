# Soldadura Sanjo Simulator — versión Android táctil

Port del juego (antes pensado para Wii con puntero IR + botón B) a una app nativa de Android.
Usa **Capacitor**: el juego corre en un WebView dentro de una app Android real (APK), 100 % offline.

## Cómo se juega en el celular

| Wii | Celular |
|---|---|
| Apuntar con el Wiimote | **Arrastrar un dedo** por la pantalla (la punta de la antorcha queda un poco arriba del dedo para no taparla) |
| Mantener botón B | **Mantener el botón SOLDAR** con el otro pulgar |
| — | Opción **Auto-soldar al tocar**: un solo dedo, suelda mientras tocas |
| — | Opción **Modo zurdo**: el botón pasa a la derecha y la antorcha se espeja |
| Botón HOME | Botón **Atrás** de Android: pausa → menú → salir |

Extras nativos: vibración (háptica), pantalla completa inmersiva, pantalla siempre encendida,
soporte de notch, orientación horizontal, pausa automática al salir de la app y récords guardados por nivel.

## Estructura

```
www/            ← EL JUEGO (index.html, style.css, game.js, fonts/). Aquí editas.
android/        ← Proyecto Android Studio (generado por Capacitor + parches propios)
capacitor.config.json
package.json
.github/workflows/build-apk.yml   ← compila el APK en la nube
```

## Opción A — Android Studio (recomendada)

Requisitos: [Node.js 20+](https://nodejs.org) y [Android Studio](https://developer.android.com/studio) (trae JDK 21 y el SDK).

```bash
npm install
npx cap sync android
npx cap open android
```

En Android Studio espera a que termine "Gradle Sync" y pulsa ▶ (celular por USB con *Depuración USB*
activada, o un emulador). Para generar el archivo: **Build ▸ Build Bundle(s) / APK(s) ▸ Build APK(s)**
→ queda en `android/app/build/outputs/apk/debug/app-debug.apk`.

## Opción B — Solo línea de comandos

Con JDK 21 y el Android SDK instalados (`ANDROID_HOME` definido):

```bash
npm install
npm run apk
```

## Opción C — Sin instalar nada (GitHub Actions)

1. Sube esta carpeta a un repositorio de GitHub.
2. Pestaña **Actions ▸ Compilar APK ▸ Run workflow**.
3. Al terminar, descarga el APK desde **Artifacts**.

## Instalar el APK en el celular

Copia `app-debug.apk` al teléfono y ábrelo (permite "Instalar apps de origen desconocido" si lo pide),
o con el celular conectado: `adb install -r app-debug.apk`.

## Publicar en Google Play (versión firmada)

1. Crea una llave (guárdala y respáldala, sin ella no puedes actualizar la app):
   `keytool -genkey -v -keystore sanjo.jks -keyalg RSA -keysize 2048 -validity 10000 -alias sanjo`
2. En Android Studio: **Build ▸ Generate Signed App Bundle / APK** ▸ *Android App Bundle* (.aab) ▸ elige `sanjo.jks`.
3. Sube el `.aab` a Play Console. Antes cambia `appId` en `capacitor.config.json`
   (y el `applicationId` en `android/app/build.gradle`) si quieres un identificador propio; no se puede cambiar después de publicar.

## Modificar el juego

Edita los archivos de `www/` y ejecuta `npx cap sync android` (o simplemente vuelve a ▶ en Android Studio tras sincronizar).
Puedes probar rápido en el navegador del PC abriendo `www/index.html` (Espacio = soldar, Esc = atrás);
las funciones nativas (vibración, botón Atrás) solo actúan dentro del APK.

## Qué cambió respecto a la versión Wii

- Se eliminaron Tailwind, FontAwesome y Google Fonts (los CDN no existen sin internet): CSS propio y fuentes dentro de la app.
- Interfaz rehecha para pantalla horizontal de celular; sin la barra "WIIMOTE", ni pie "WII READY / SD CARD".
- Entrada con Pointer Events y multitoque (un dedo mueve, otro suelda).
- Rendimiento: el cordón frío y el fondo se pre-renderizan, sin `shadowBlur`, el DOM del HUD solo se actualiza al cambiar.
- La lógica de puntaje/precisión corre a 60 Hz fijos, así que pantallas de 90/120 Hz no inflan el puntaje.
- Tolerancia y tamaños escalan con el alto de pantalla (+10 % de margen por ser dedo y no puntero IR).
- Corregido: el sonido del arco podía quedar mudo si soltabas y volvías a soldar en menos de 60 ms.
- Si la antorcha se sobrecalienta y sigues sosteniendo SOLDAR, retoma sola al enfriarse.
