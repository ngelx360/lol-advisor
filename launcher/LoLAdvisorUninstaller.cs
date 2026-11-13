using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;
using Microsoft.Win32;

namespace LoLAdvisorUninstaller
{
    internal static class Program
    {
        private const string AppName = "LoL Ranked Advisor";
        private const string UninstallRegPath = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\LoLRankedAdvisor";

        [STAThread]
        private static void Main(string[] args)
        {
            Application.EnableVisualStyles();
            bool silent = false;
            string installDir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');

            for (int i = 0; i < args.Length; i++)
            {
                if (args[i] == "--silent") silent = true;
                else if (args[i] == "--dir" && i + 1 < args.Length) installDir = args[++i].TrimEnd('\\');
            }

            if (!silent)
            {
                DialogResult res = MessageBox.Show(
                    "¿Deseas desinstalar " + AppName + " de esta carpeta?\n\n" + installDir,
                    "Desinstalar " + AppName,
                    MessageBoxButtons.YesNo,
                    MessageBoxIcon.Question
                );
                if (res != DialogResult.Yes) return;
            }

            KillProcessesInDir(installDir);

            // Remove Desktop & Start Menu shortcuts
            try
            {
                string desktopLink = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory),
                    AppName + ".lnk"
                );
                if (File.Exists(desktopLink)) File.Delete(desktopLink);

                string startMenuDir = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.StartMenu),
                    "Programs",
                    AppName
                );
                if (Directory.Exists(startMenuDir)) Directory.Delete(startMenuDir, true);
            }
            catch { }

            // Remove Add/Remove Programs registry entry
            try
            {
                Registry.CurrentUser.DeleteSubKeyTree(UninstallRegPath, false);
            }
            catch { }

            // Clean up Fallback AppData\Local\LoL Ranked Advisor\data if present
            try
            {
                string localData = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    AppName
                );
                if (Directory.Exists(localData) && !string.Equals(localData.TrimEnd('\\'), installDir, StringComparison.OrdinalIgnoreCase))
                {
                    Directory.Delete(localData, true);
                }
            }
            catch { }

            // Delete install directory after this process exits
            try
            {
                if (Directory.Exists(installDir))
                {
                    var psi = new ProcessStartInfo
                    {
                        FileName = "cmd.exe",
                        Arguments = "/c ping -n 2 127.0.0.1 >nul & rmdir /s /q \"" + installDir + "\"",
                        CreateNoWindow = true,
                        WindowStyle = ProcessWindowStyle.Hidden,
                        UseShellExecute = false
                    };
                    Process.Start(psi);
                }
            }
            catch { }

            if (!silent)
            {
                MessageBox.Show(
                    AppName + " se desinstaló correctamente.",
                    "Desinstalación completada",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Information
                );
            }
        }

        private static void KillProcessesInDir(string dir)
        {
            string normDir = dir.ToLowerInvariant();
            string[] names = { "LoL Advisor", "LoL Overlay", "node" };
            foreach (string name in names)
            {
                try
                {
                    foreach (Process p in Process.GetProcessesByName(name))
                    {
                        try
                        {
                            string exePath = p.MainModule != null ? p.MainModule.FileName : "";
                            if (!string.IsNullOrEmpty(exePath) && exePath.ToLowerInvariant().StartsWith(normDir))
                            {
                                p.Kill();
                                p.WaitForExit(1500);
                            }
                        }
                        catch { }
                    }
                }
                catch { }
            }
        }
    }
}
