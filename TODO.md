# Tareas del proyecto

## Implementado

- [x] Integrar el panel de comandas en el acceso de propietaria.
- [x] Preparar el selector de productos y variantes con cantidades, notas y mesa o referencia.
- [x] Guardar comandas e intentos de impresión y ofrecer reimpresión explícita.
- [x] Preparar el puente Windows, la configuración de ejemplo y la prueba sin papel.
- [x] Verificar el circuito local de inicio de sesión, borrador, cola, confirmación simulada y reimpresión.
- [x] Añadir el mapa de mesas, las cuentas por mesa y el cobro por partes.
- [x] Incorporar recogida en el bar, domicilio y las tarifas por zona.
- [x] Adaptar el ticket de cocina al ejemplo de La Barca.
- [x] Añadir diagnóstico privado, eventos de impresión y estado del puente Windows.

## Puesta en marcha en el local

- [ ] Confirmar el nombre de la cola instalada y el ancho de papel configurado en el PC Windows. Imprimir su página de prueba.
- [ ] Guardar una copia privada de la base D1 actual y preparar el secreto de impresora de Cloudflare.
- [ ] Configurar `LOG_ADMIN_PASSWORD_HASH` en Cloudflare y comprobar que solo el acceso de `LaGlotona` abre el diagnóstico.
- [ ] Validar en una vista previa con D1 y secretos de prueba. Publicar en el proyecto existente con el vínculo de producción `DB`.
- [ ] Ejecutar el puente desde la cuenta Windows que se utilizará durante el servicio.
- [ ] Ajustar el número de mesas a la distribución del local.
- [ ] Enviar comandas de mesa, recogida y domicilio desde un móvil. Verificar números de cuenta y comanda, notas, dirección, importes, ancho y corte si lo admite el controlador.
- [ ] Probar el cobro dividido de una mesa y comprobar que se libera al registrar el último pago.
- [ ] Probar la cola con el puente detenido y vuelto a iniciar. Revisar en Windows y en papel antes de solicitar una copia de prueba.
- [ ] Si se activa el inicio automático, cerrar y volver a iniciar sesión en Windows y confirmar que solo queda un puente operativo.
