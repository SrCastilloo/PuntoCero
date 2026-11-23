# Impresión de comandas en la POS-80USB

El puente descarga por HTTPS los trabajos pendientes y envía los tickets a una cola de Windows. Puedes tomar las comandas desde el móvil, la tableta o el PC. La POS-80USB se conecta por USB al PC de impresión, que debe estar encendido, conectado a Internet y con el puente en ejecución durante el servicio.

## 1. Configurar la impresora en Windows

1. Conecta la POS-80USB por USB, enciéndela y coloca un rollo de 80 mm. Si Windows no la instala, usa el controlador de impresión de Windows del fabricante o distribuidor de tu unidad.
2. Abre **Configuración → Impresoras y escáneres**. Selecciona la impresora y ajusta el papel de 80 mm en **Preferencias de impresión**. Imprime una página de prueba desde Windows.
3. Abre PowerShell en la carpeta que contiene `printer`, ya sea la raíz del proyecto o el paquete de Windows descomprimido. Lista las colas y copia el nombre exacto de la tuya.

   ```powershell
   powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File .\printer\Print-Comandas.ps1 -ListPrinters
   if (!(Test-Path .\printer\printer.config.json)) {
       Copy-Item .\printer\printer.config.example.json .\printer\printer.config.json
   }
   notepad .\printer\printer.config.json
   ```

   Escribe el nombre de la cola en **printerName**. En **siteUrl** escribe el origen HTTPS del proyecto activo, sin añadir la ruta de la carta ni del panel. Guarda este archivo en el PC y usa una sola instalación del puente para esta impresora. El puente carga el archivo junto al script. Si lo guardas en otra carpeta, usa `-ConfigPath` con la ruta completa al iniciar el puente o ejecutar `-TestPrint`.

Los comandos abren Windows PowerShell con la política **RemoteSigned** para ese proceso. Si Windows marcó los archivos como descargados, revisa los scripts y, tras verificar su procedencia, puedes desbloquear esos dos archivos concretos con `Unblock-File -LiteralPath .\printer\Print-Comandas.ps1, .\printer\Save-PrinterToken.ps1`.

## 2. Probar el ticket local

```powershell
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File .\printer\Print-Comandas.ps1 -DryRun
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File .\printer\Print-Comandas.ps1 -TestPrint
```

La primera prueba muestra el ticket de ejemplo en la consola. La segunda lo envía a la cola configurada. Ambas funcionan sin token y sin consultar la cola web. Comprueba que el papel sale con el ancho correcto y que las cantidades, las tildes y las notas se leen bien. Si Windows admite el trabajo pero el ticket no sale, abre la cola de impresión y revisa que la impresora tenga papel, que esté conectada y que la cola no esté pausada o en modo sin conexión.

La prueba abre por defecto un ejemplo de mesa. Añade `-Scenario Recogida`, `-Scenario Domicilio`, `-Scenario Copia` o `-Scenario Historica` al final de cualquiera de los dos comandos para comprobar las variantes. La comanda de domicilio del ejemplo usa datos ficticios.

El ticket sigue el formato de La Barca con la hora de Madrid, la cuenta, el número de comanda y el grupo de productos. Para mesa y recogida se imprime el pedido de cocina, sin importes. Para domicilio aparecen también la dirección, el teléfono, la forma de pago, el envío y el total. Si se facilitó el importe en efectivo, se imprime cuánto entregará el cliente y el cambio. Las comandas históricas conservan su referencia y muestran `Cuenta: -` si se crearon antes de asignar cuentas.

La longitud de página y el corte dependen de las preferencias del controlador de 80 mm. Si el ticket deja mucho papel en blanco o se reparte de forma incómoda, prueba otra opción de rollo admitida por ese controlador y vuelve a imprimir el ejemplo. Comprueba también una comanda larga con notas antes de usarla en el servicio.

## 3. Vincular el puente con la web

Configura el secreto **PRINT_AGENT_TOKEN** en Cloudflare según las instrucciones del README del proyecto. Con el mismo usuario de Windows que ejecutará el puente, guarda el mismo valor mediante el siguiente comando. Se solicita en un campo oculto y se cifra con DPAPI para ese usuario del PC.

```powershell
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File .\printer\Save-PrinterToken.ps1
```

Inicia el puente y deja la ventana abierta durante el servicio.

```powershell
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File .\printer\Print-Comandas.ps1
```

Crea una comanda desde el panel y comprueba que su número coincide con el ticket. El estado **Enviada a Windows** indica que el controlador aceptó el trabajo. Comprueba el papel para confirmar que salió. Si el estado es incierto, revisa el papel y la cola de Windows antes de pulsar **Reimprimir**. Esa acción crea un nuevo intento y el ticket se identifica como copia. Si se corta Internet después del envío, el puente reintenta comunicar el resultado del mismo intento.

Los tickets de domicilio y los trabajos de la cola de Windows contienen dirección y teléfono. Mantén el PC y los tickets al alcance del personal autorizado y destruye el papel cuando ya no haga falta para la entrega. Evita activar la conservación de documentos impresos en la cola.

## Diagnóstico de Windows

El puente comunica a la web el estado de la cola de Windows al iniciar, cuando cambia y aproximadamente cada minuto. Si la web no admite esta función o se corta la conexión, el programa sigue intentando consultar la cola y confirmar las impresiones. El panel muestra el último estado recibido. Comprueba en papel que la impresora funciona.

El registro del usuario de Windows se guarda en `%LOCALAPPDATA%\PuntoCero\print-bridge.log`. Guarda fechas, códigos y mensajes operativos de inicio, configuración, conexión e impresión. Al llegar aproximadamente a 1 MiB pasa a `print-bridge.log.1` y se elimina la copia anterior. Consulta las últimas líneas incluso después de cerrar el puente.

```powershell
$log = Join-Path $env:LOCALAPPDATA 'PuntoCero\print-bridge.log'
Get-Content -LiteralPath $log -Encoding UTF8 -Tail 80
```

Si el puente falla al arrancar, revisa primero el código del registro. Para un error de cola, ejecuta `-ListPrinters` y compara el resultado con `printerName`. Si Windows aún no ha ejecutado el script, revisa el mensaje de PowerShell o el historial de la tarea. Comparte únicamente las líneas operativas necesarias al pedir soporte y guarda la credencial DPAPI en el PC.

## Inicio al entrar en Windows

Para abrir el puente automáticamente, crea una tarea en el **Programador de tareas** con el desencadenador **Al iniciar sesión** para el mismo usuario que guardó el token. Selecciona **Ejecutar solo cuando el usuario haya iniciado sesión**.

| Campo | Valor |
| --- | --- |
| Programa | `powershell.exe` |
| Argumentos | `-NoProfile -ExecutionPolicy RemoteSigned -File "C:\ruta\al\proyecto\printer\Print-Comandas.ps1"` |

Ajusta la ruta al lugar donde guardaste el proyecto. En la configuración de la tarea, desactiva el límite que la detiene tras varios días y, si quieres recuperación automática, activa el reinicio si la tarea falla. En un portátil que deba imprimir con batería, revisa la condición de corriente alterna. La tarea necesita que Windows siga activo durante el servicio. Puedes detener la ejecución manual con **Ctrl+C** o parar la tarea desde el Programador.
