# Guía para trabajar en este repositorio

- Lee `README.md`, `memory.md` y `TODO.md` antes de cambiar el flujo de comandas, impresión o despliegue.
- Trabaja en español para la interfaz y la documentación operativa. Conserva la estructura de la carta y las rutas públicas `/carta`, `/api/menu` y `/qr/carta-qr.svg`.
- Reutiliza la sesión de propietaria del servidor. Protege todas las rutas privadas de comandas y valida en el servidor mesa, cantidades y precios. El cliente de impresión usa exclusivamente su propia credencial.
- Mantén los importes en céntimos y guarda una copia del nombre, tamaño, precio y notas de cada línea al registrar la comanda. Las ediciones posteriores de la carta no deben alterar los tickets guardados.
- Calcula las tarifas de reparto en el servidor. Mantén el número de cuenta en todas las rondas de una mesa. Registra cada cobro una vez y libera la mesa al quedar el saldo liquidado.
- Limita los datos de domicilio a las rutas privadas de propietaria y de impresión. Usa direcciones y teléfonos ficticios en las pruebas.
- Mantén la sesión de diagnóstico independiente de propietaria y del token de impresión. Registra códigos operativos sin contraseñas, tokens, direcciones, teléfonos ni cuerpos de peticiones.
- Conserva la clave idempotente del envío y la toma atómica de trabajos. Cualquier resultado de impresión dudoso queda para revisión humana. Las reimpresiones autorizadas deben quedar identificadas como copia.
- Verifica cambios con `npm test`. Si tocas `printer/`, ejecuta también `powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File .\printer\Print-Comandas.ps1 -DryRun`. La validación del ticket en papel se hace con la POS-80USB del local.
- Mantén secretos, credenciales, copias de D1, datos reales de comandas y configuración de la impresora de cada equipo fuera de Git y de `public/`.
- Confirma que el alojamiento de producción conserva el vínculo D1 `DB` y el secreto `ADMIN_CODE_HASH` antes de publicar en el proyecto existente. Actualiza `memory.md` y `TODO.md` cuando cambien decisiones o verificaciones.
