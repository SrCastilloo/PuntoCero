using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Printing;
using System.Globalization;
using System.Text;

namespace PuntoCero
{
    public static class TicketPrinter
    {
        public static void Check(string printerName)
        {
            using (PrintDocument document = Open(printerName))
            {
                // The driver must be set to the width of the actual receipt roll.
                int width = document.DefaultPageSettings.PaperSize.Width;
                if (width < 280 || width > 335)
                {
                    throw new InvalidOperationException("Configura el rollo de 80 mm en las preferencias de la impresora.");
                }
            }
        }

        public static void Print(string printerName, string documentName, string[] rows)
        {
            using (PrintDocument document = Open(printerName))
            using (Font body = new Font("Consolas", 10, FontStyle.Regular))
            using (Font bold = new Font("Consolas", 10, FontStyle.Bold))
            using (Font title = new Font("Consolas", 12, FontStyle.Bold))
            using (StringFormat format = (StringFormat)StringFormat.GenericTypographic.Clone())
            {
                document.DocumentName = documentName;
                document.PrintController = new StandardPrintController();
                format.FormatFlags |= StringFormatFlags.NoWrap;
                List<PrintedLine> lines = null;
                int index = 0;

                document.PrintPage += delegate(object sender, PrintPageEventArgs page)
                {
                    // In the printer's Display units, 100 units equal one inch.
                    const float inset = 8;
                    RectangleF printable = page.PageSettings.PrintableArea;
                    float width = printable.Width - inset * 2;
                    float bottom = printable.Height - inset;
                    if (width < 120 || bottom < 50)
                    {
                        throw new InvalidOperationException("El controlador no comunica un area de impresion util.");
                    }

                    if (lines == null)
                    {
                        lines = new List<PrintedLine>();
                        for (int row = 0; row < rows.Length; row++)
                        {
                            string value = rows[row];
                            if (value == "[linea]")
                            {
                                lines.Add(new PrintedLine { Text = "", Font = body, Rule = true });
                                continue;
                            }
                            bool centered = value.StartsWith("^", StringComparison.Ordinal);
                            if (centered)
                            {
                                value = value.Substring(1);
                            }
                            Font font = row == 0 ? title : body;
                            if (value.StartsWith("!", StringComparison.Ordinal))
                            {
                                font = bold;
                                value = value.Substring(1);
                            }
                            foreach (string line in Wrap(value, page.Graphics, font, width, format))
                            {
                                lines.Add(new PrintedLine { Text = line, Font = font, Centered = centered });
                            }
                        }
                    }

                    float y = inset;
                    while (index < lines.Count)
                    {
                        PrintedLine line = lines[index];
                        float height = page.Graphics.MeasureString("Ag", line.Font, int.MaxValue, format).Height + 3;
                        if (y + height > bottom)
                        {
                            if (y == inset)
                            {
                                throw new InvalidOperationException("El papel configurado no admite una linea del ticket.");
                            }
                            break;
                        }
                        if (line.Rule)
                        {
                            float ruleY = y + height / 2;
                            page.Graphics.DrawLine(Pens.Black, inset, ruleY, inset + width, ruleY);
                        }
                        else if (line.Text.Length != 0)
                        {
                            float x = inset;
                            if (line.Centered)
                            {
                                float textWidth = page.Graphics.MeasureString(line.Text, line.Font, int.MaxValue, format).Width;
                                x += Math.Max(0, (width - textWidth) / 2);
                            }
                            page.Graphics.DrawString(line.Text, line.Font, Brushes.Black, new PointF(x, y), format);
                        }
                        y += height;
                        index++;
                    }
                    page.HasMorePages = index < lines.Count;
                };
                document.Print();
            }
        }

        private static PrintDocument Open(string printerName)
        {
            var document = new PrintDocument();
            try
            {
                document.PrinterSettings.PrinterName = printerName;
                if (!document.PrinterSettings.IsValid)
                {
                    throw new InvalidOperationException("Windows no encuentra la cola seleccionada.");
                }
                document.DefaultPageSettings.Landscape = false;
                return document;
            }
            catch
            {
                document.Dispose();
                throw;
            }
        }

        private static IEnumerable<string> Wrap(string text, Graphics graphics, Font font, float width, StringFormat format)
        {
            var line = new StringBuilder();
            int lastSpace = -1;
            TextElementEnumerator elements = StringInfo.GetTextElementEnumerator(text);
            while (elements.MoveNext())
            {
                string element = elements.GetTextElement();
                line.Append(element);
                if (graphics.MeasureString(line.ToString(), font, int.MaxValue, format).Width > width)
                {
                    if (lastSpace >= 0)
                    {
                        yield return line.ToString(0, lastSpace).TrimEnd();
                        line.Remove(0, lastSpace + 1);
                    }
                    else if (line.Length > element.Length)
                    {
                        yield return line.ToString(0, line.Length - element.Length);
                        line.Remove(0, line.Length - element.Length);
                    }
                    lastSpace = -1;
                }
                if (element == " ")
                {
                    if (line.Length == 1) line.Clear();
                    else lastSpace = line.Length - 1;
                }
            }
            yield return line.ToString().TrimEnd();
        }

        private sealed class PrintedLine
        {
            public string Text;
            public Font Font;
            public bool Centered;
            public bool Rule;
        }
    }
}
