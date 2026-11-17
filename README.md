# ટાવર પેટ્રોલ (Tower Patrol)

ટ્રાન્સમિશન ટાવર પેટ્રોલિંગ માટે ઑફલાઇન ચાલતી મોબાઇલ વેબ-ઍપ (PWA).

- પહેલી વાર ચાલીને જાઓ ત્યારે GPS થી રસ્તો રેકોર્ડ કરો અને દરેક ટાવર પર "અહીં ટાવર ઉમેરો" દબાવો.
- પછી કોઈ પણ ટાવર પસંદ કરી "અહીં જાઓ" દબાવો: ઍપ રેકોર્ડ કરેલા રસ્તે રસ્તો બતાવે છે, દિશાનું તીર અને બાકી અંતર સાથે. Google Maps બટન પણ છે.
- બધો ડેટા ફોનમાં જ (IndexedDB) રહે છે. GPX / KML / CSV / JSON માં Export અને Import.
- નકશાની ટાઇલ્સ જોવાતાં જ ફોનમાં સચવાય છે; "નકશો ફોનમાં સાચવો" થી આખા વિસ્તારની ટાઇલ્સ પહેલેથી સાચવી શકાય.

Plain HTML/JS, no build step. Leaflet 1.9.4 is vendored in `lib/`. Hosted with GitHub Pages from the `main` branch root.

## Android APK

દરેક push પછી GitHub Actions APK બનાવે છે: https://github.com/satish5979/tower-patrol/releases/download/latest-apk/tower-patrol.apk

The APK is a Capacitor wrapper around the same files (`android/build.sh`). It is signed with the committed `android/debug.keystore` so that every new build installs over the previous one.
