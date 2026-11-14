using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Text;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace LoLOverlayApp
{
    internal sealed class OverlayForm : Form
    {
        private const string BaseUrl = "http://127.0.0.1:3848";

        private const int WS_EX_LAYERED = 0x80000;
        private const int WS_EX_TRANSPARENT = 0x20;
        private const int WS_EX_TOOLWINDOW = 0x80;
        private const int WS_EX_NOACTIVATE = 0x08000000;
        private const int GWL_EXSTYLE = -20;

        private const int WM_HOTKEY = 0x0312;
        private const int MOD_CONTROL = 0x0002;
        private const int MOD_SHIFT = 0x0004;
        private const int HOTKEY_TOGGLE_VIS = 1;
        private const int HOTKEY_TOGGLE_LOCK = 2;

        [DllImport("user32.dll")]
        private static extern int GetWindowLong(IntPtr hwnd, int index);

        [DllImport("user32.dll")]
        private static extern int SetWindowLong(IntPtr hwnd, int index, int newStyle);

        [DllImport("user32.dll")]
        private static extern bool RegisterHotKey(IntPtr hWnd, int id, int fsModifiers, int vk);

        [DllImport("user32.dll")]
        private static extern bool UnregisterHotKey(IntPtr hWnd, int id);

        private readonly System.Windows.Forms.Timer _pollTimer;
        private readonly JavaScriptSerializer _json = new JavaScriptSerializer();
        private readonly Dictionary<int, Image> _iconCache = new Dictionary<int, Image>();

        private const int BaseW = 236;
        private const int BaseH = 178;

        private Dictionary<string, object> _state;
        private bool _isLocked = true;
        private bool _isDemo = false;
        private bool _userHidden = false;
        private bool _isDragging = false;
        private float _scale = 1.0f;
        private Point _dragStartMouse;
        private Point _dragStartForm;
        private string _lastConfigSnapshot = "";

        // Hextech subtle translucent palette
        private static readonly Color ColInk = Color.FromArgb(6, 13, 16);
        private static readonly Color ColPanel2 = Color.FromArgb(10, 21, 25);
        private static readonly Color ColSubtleEdge = Color.FromArgb(32, 58, 64);
        private static readonly Color ColBone = Color.FromArgb(233, 228, 212);
        private static readonly Color ColMuted = Color.FromArgb(152, 174, 177);
        private static readonly Color ColBrass = Color.FromArgb(184, 151, 90);
        private static readonly Color ColHex = Color.FromArgb(63, 208, 212);
        private static readonly Color ColZaun = Color.FromArgb(232, 81, 127);

        public OverlayForm()
        {
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            TopMost = true;
            StartPosition = FormStartPosition.Manual;
            DoubleBuffered = true;
            BackColor = ColInk;
            Opacity = 0.68;
            Width = 236;
            Height = 178;

            Rectangle area = Screen.PrimaryScreen.WorkingArea;
            Location = new Point(area.Right - Width - 14, 74);

            MouseDown += OnOverlayMouseDown;
            MouseMove += OnOverlayMouseMove;
            MouseUp += OnOverlayMouseUp;

            _pollTimer = new System.Windows.Forms.Timer { Interval = 1400 };
            _pollTimer.Tick += (s, e) => RefreshData();
            _pollTimer.Start();
        }

        protected override bool ShowWithoutActivation
        {
            get { return true; }
        }

        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams cp = base.CreateParams;
                cp.ExStyle |= WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_LAYERED | WS_EX_TRANSPARENT;
                return cp;
            }
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            ApplyClickThrough(_isLocked);
            RegisterHotKey(Handle, HOTKEY_TOGGLE_VIS, MOD_CONTROL | MOD_SHIFT, (int)Keys.O);
            RegisterHotKey(Handle, HOTKEY_TOGGLE_LOCK, MOD_CONTROL | MOD_SHIFT, (int)Keys.L);
            RefreshData();
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            UnregisterHotKey(Handle, HOTKEY_TOGGLE_VIS);
            UnregisterHotKey(Handle, HOTKEY_TOGGLE_LOCK);
            _pollTimer.Stop();
            base.OnFormClosing(e);
        }

        protected override void WndProc(ref Message m)
        {
            if (m.Msg == WM_HOTKEY)
            {
                int id = m.WParam.ToInt32();
                if (id == HOTKEY_TOGGLE_VIS)
                {
                    _userHidden = !_userHidden;
                    Visible = !_userHidden;
                }
                else if (id == HOTKEY_TOGGLE_LOCK)
                {
                    _isLocked = !_isLocked;
                    ApplyClickThrough(_isLocked);
                    Cursor = _isLocked ? Cursors.Default : Cursors.SizeAll;
                    Invalidate();
                }
            }
            base.WndProc(ref m);
        }

        private void ApplyClickThrough(bool clickThrough)
        {
            if (!IsHandleCreated) return;
            int exStyle = GetWindowLong(Handle, GWL_EXSTYLE);
            if (clickThrough)
                exStyle |= WS_EX_TRANSPARENT | WS_EX_NOACTIVATE;
            else
                exStyle &= ~WS_EX_TRANSPARENT;
            SetWindowLong(Handle, GWL_EXSTYLE, exStyle);
        }

        private void OnOverlayMouseDown(object sender, MouseEventArgs e)
        {
            if (_isLocked || e.Button != MouseButtons.Left) return;
            _isDragging = true;
            _dragStartMouse = Cursor.Position;
            _dragStartForm = Location;
        }

        private void OnOverlayMouseMove(object sender, MouseEventArgs e)
        {
            if (!_isDragging) return;
            Point cur = Cursor.Position;
            Location = new Point(
                _dragStartForm.X + (cur.X - _dragStartMouse.X),
                _dragStartForm.Y + (cur.Y - _dragStartMouse.Y)
            );
        }

        private void OnOverlayMouseUp(object sender, MouseEventArgs e)
        {
            if (!_isDragging) return;
            _isDragging = false;
            SaveOverlayPosition();
        }

        private void SaveOverlayPosition()
        {
            try
            {
                string jsonBody = string.Format("{{\"overlayX\":{0},\"overlayY\":{1}}}", Location.X, Location.Y);
                var req = (HttpWebRequest)WebRequest.Create(BaseUrl + "/api/config");
                req.Method = "POST";
                req.ContentType = "application/json";
                req.Timeout = 800;
                byte[] bytes = Encoding.UTF8.GetBytes(jsonBody);
                using (Stream s = req.GetRequestStream()) s.Write(bytes, 0, bytes.Length);
                using (req.GetResponse()) { }
            }
            catch { }
        }

        private void RefreshData()
        {
            try
            {
                string cfgRaw = HttpGetString(BaseUrl + "/api/bootstrap");
                if (!string.IsNullOrEmpty(cfgRaw) && cfgRaw != _lastConfigSnapshot)
                {
                    _lastConfigSnapshot = cfgRaw;
                    var boot = _json.Deserialize<Dictionary<string, object>>(cfgRaw);
                    var cfg = boot != null && boot.ContainsKey("config")
                        ? boot["config"] as Dictionary<string, object>
                        : null;
                    if (cfg != null)
                    {
                        bool cfgDemo = cfg.ContainsKey("overlayDemo") && Convert.ToBoolean(cfg["overlayDemo"]);
                        bool cfgLocked = !cfg.ContainsKey("overlayLocked") || Convert.ToBoolean(cfg["overlayLocked"]);
                        _isDemo = cfgDemo;
                        _pollTimer.Interval = _isDemo ? 750 : 1400;

                        if (cfgLocked != _isLocked)
                        {
                            _isLocked = cfgLocked;
                            ApplyClickThrough(_isLocked);
                            Cursor = _isLocked ? Cursors.Default : Cursors.SizeAll;
                            Invalidate();
                        }

                        if (cfg.ContainsKey("overlayScale") && cfg["overlayScale"] != null)
                        {
                            float sc = (float)Convert.ToDouble(cfg["overlayScale"]);
                            _scale = Math.Max(0.75f, Math.Min(1.45f, sc));
                        }

                        if (cfg.ContainsKey("overlayOpacity") && cfg["overlayOpacity"] != null)
                        {
                            double op = Convert.ToDouble(cfg["overlayOpacity"]);
                            Opacity = Math.Max(0.30, Math.Min(0.95, op));
                        }

                        int targetW = (int)Math.Round(BaseW * _scale);
                        int targetH = (int)Math.Round(BaseH * _scale);
                        if (Width != targetW || Height != targetH)
                        {
                            int rightEdge = Right;
                            Width = targetW;
                            Height = targetH;
                            if (!_isDragging && (Location.X + Width > Screen.PrimaryScreen.WorkingArea.Right))
                            {
                                Location = new Point(rightEdge - Width, Location.Y);
                            }
                        }

                        if (!_isDragging)
                        {
                            if (cfg.ContainsKey("overlayX") && cfg.ContainsKey("overlayY")
                                && cfg["overlayX"] != null && cfg["overlayY"] != null)
                            {
                                int ox = Convert.ToInt32(cfg["overlayX"]);
                                int oy = Convert.ToInt32(cfg["overlayY"]);
                                if (ox >= 0 && oy >= 0) Location = new Point(ox, oy);
                            }
                            else
                            {
                                Rectangle area = Screen.PrimaryScreen.WorkingArea;
                                Location = new Point(area.Right - Width - 14, 74);
                            }
                        }
                    }
                }

                string url = BaseUrl + "/api/live-overlay" + (_isDemo ? "?demo=1" : "");
                string raw = HttpGetString(url);
                if (string.IsNullOrEmpty(raw)) return;

                _state = _json.Deserialize<Dictionary<string, object>>(raw);
                bool inGame = _state != null && _state.ContainsKey("inGame") && Convert.ToBoolean(_state["inGame"]);

                if (!inGame)
                {
                    if (Visible) Visible = false;
                    return;
                }

                PreloadStepIcons();
                if (!_userHidden)
                {
                    if (!Visible) Visible = true;
                    TopMost = true;
                }
                Invalidate();
            }
            catch
            {
                // Keep overlay running even if server momentarily restarts
            }
        }

        private void PreloadStepIcons()
        {
            if (_state == null || !_state.ContainsKey("buyOrder")) return;
            var list = _state["buyOrder"] as System.Collections.ArrayList;
            if (list == null) return;
            foreach (object obj in list)
            {
                var item = obj as Dictionary<string, object>;
                if (item == null || !item.ContainsKey("id")) continue;
                int id = Convert.ToInt32(item["id"]);
                if (id <= 0 || _iconCache.ContainsKey(id)) continue;
                try
                {
                    var req = (HttpWebRequest)WebRequest.Create(BaseUrl + "/api/item-icon/" + id + ".png");
                    req.Timeout = 1500;
                    using (var resp = (HttpWebResponse)req.GetResponse())
                    using (var stream = resp.GetResponseStream())
                    {
                        if (stream != null)
                        {
                            _iconCache[id] = Image.FromStream(stream);
                        }
                    }
                }
                catch { }
            }
        }

        private static string HttpGetString(string url)
        {
            var req = (HttpWebRequest)WebRequest.Create(url);
            req.Method = "GET";
            req.Timeout = 1000;
            using (var resp = (HttpWebResponse)req.GetResponse())
            using (var reader = new StreamReader(resp.GetResponseStream(), Encoding.UTF8))
            {
                return reader.ReadToEnd();
            }
        }

        private static Color StatusColor(string status)
        {
            if (status == "ahead") return ColHex;
            if (status == "behind") return ColZaun;
            return ColBrass;
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.InterpolationMode = InterpolationMode.HighQualityBicubic;
            g.TextRenderingHint = TextRenderingHint.ClearTypeGridFit;
            g.Clear(ColInk);
            g.ScaleTransform(_scale, _scale);

            using (var bgBrush = new SolidBrush(ColInk))
                g.FillRectangle(bgBrush, 0, 0, BaseW, BaseH);

            using (var borderPen = new Pen(_isLocked ? ColSubtleEdge : Color.FromArgb(245, 158, 11), _isLocked ? 1f : 2.5f))
                g.DrawRectangle(borderPen, 0, 0, BaseW - 1, BaseH - 1);

            using (var accentBrush = new SolidBrush(ColHex))
                g.FillRectangle(accentBrush, 0, 0, 2, BaseH);

            bool inGame = _state != null && _state.ContainsKey("inGame") && Convert.ToBoolean(_state["inGame"]);
            if (!inGame) return;

            var myChamp = _state["myChampion"] as Dictionary<string, object>;
            var oppChamp = _state.ContainsKey("opponentChampion") ? _state["opponentChampion"] as Dictionary<string, object> : null;
            var cs = _state["cs"] as Dictionary<string, object>;
            var xp = _state["xp"] as Dictionary<string, object>;
            var buyOrder = _state["buyOrder"] as System.Collections.ArrayList;
            var nextItem = _state.ContainsKey("nextItem") ? _state["nextItem"] as Dictionary<string, object> : null;
            string timeLabel = Convert.ToString(_state["gameTimeLabel"] ?? "0:00");
            bool isDemo = _state.ContainsKey("isDemo") && Convert.ToBoolean(_state["isDemo"]);
            string counterNote = Convert.ToString(_state["counterNote"] ?? "");

            string myName = Convert.ToString(myChamp != null ? myChamp["name"] : "Tú");
            string oppName = oppChamp != null ? Convert.ToString(oppChamp["name"]) : "";
            string title = string.IsNullOrEmpty(oppName) ? myName : (myName + " vs " + oppName);

            // Compact header bar
            using (var hdrBrush = new SolidBrush(ColPanel2))
                g.FillRectangle(hdrBrush, 2, 1, BaseW - 3, 20);
            using (var fTitle = new Font("Segoe UI", 8.2f, FontStyle.Bold))
            using (var fMono = new Font("Consolas", 8f, FontStyle.Bold))
            using (var bBone = new SolidBrush(ColBone))
            using (var bHex = new SolidBrush(ColHex))
            {
                g.DrawString(title, fTitle, bBone, new RectangleF(7, 3, BaseW - 74, 16));
                string rightTag = (!_isLocked ? "★ MOVER (ARRASTRA) " : (isDemo ? "DEMO " : "")) + timeLabel;
                SizeF sz = g.MeasureString(rightTag, fMono);
                g.DrawString(rightTag, fMono, _isLocked ? bHex : new SolidBrush(Color.FromArgb(245, 158, 11)), BaseW - sz.Width - 6, 3);
            }

            // Two compact metric blocks: FARMEO & EXP
            int boxY = 25;
            int boxH = 44;
            int boxW = (BaseW - 18) / 2;

            DrawMetricCard(g, 7, boxY, boxW, boxH,
                "FARMEO",
                string.Format("{0} ({1}/m)", cs["current"], cs["perMin"]),
                string.Format("Meta: {0}/m ({1})", cs["targetPerMin"], cs["targetTotal"]),
                StatusColor(Convert.ToString(cs["status"])));

            string diffOpp = "";
            if (xp.ContainsKey("levelDiffVsOpp") && xp["levelDiffVsOpp"] != null)
            {
                int ld = Convert.ToInt32(xp["levelDiffVsOpp"]);
                diffOpp = string.Format(" ({0}{1})", ld >= 0 ? "+" : "", ld);
            }
            DrawMetricCard(g, 11 + boxW, boxY, boxW, boxH,
                "EXP / NIVEL",
                string.Format("Nv {0}{1}", xp["currentLevel"], diffOpp),
                string.Format("Meta: Nv {0} ({1})", xp["expectedLevelRounded"], xp["expectedLevel"]),
                StatusColor(Convert.ToString(xp["status"])));

            // Build section
            int buildY = 74;
            using (var fLabel = new Font("Segoe UI", 7f, FontStyle.Bold))
            using (var fNext = new Font("Segoe UI", 7.4f, FontStyle.Regular))
            using (var bBrass = new SolidBrush(ColBrass))
            using (var bBone = new SolidBrush(ColBone))
            using (var bHex = new SolidBrush(ColHex))
            {
                g.DrawString("BUILD", fLabel, bBrass, 7, buildY);
                if (nextItem != null)
                {
                    int goldNeed = Convert.ToInt32(nextItem["goldNeeded"]);
                    string nextTxt = goldNeed == 0
                        ? "¡" + nextItem["name"] + "!"
                        : nextItem["name"] + " (-" + goldNeed + "g)";
                    SizeF nSz = g.MeasureString(nextTxt, fNext);
                    float maxX = Math.Max(46, BaseW - nSz.Width - 6);
                    g.DrawString(nextTxt, fNext, goldNeed == 0 ? bHex : bBone, new RectangleF(maxX, buildY - 1, BaseW - maxX - 5, 14));
                }
            }

            // Item icons row (up to 6 compact icons)
            int iconsY = buildY + 15;
            int iconSize = 26;
            int gap = 10;
            if (buyOrder != null && buyOrder.Count > 0)
            {
                int count = Math.Min(6, buyOrder.Count);
                for (int i = 0; i < count; i++)
                {
                    var it = buyOrder[i] as Dictionary<string, object>;
                    if (it == null) continue;
                    int ix = 7 + i * (iconSize + gap);
                    int id = Convert.ToInt32(it["id"]);
                    bool owned = Convert.ToBoolean(it["owned"]);
                    bool isNext = nextItem != null && Convert.ToInt32(nextItem["id"]) == id;
                    string stage = Convert.ToString(it["stage"]);

                    if (_iconCache.ContainsKey(id))
                    {
                        g.DrawImage(_iconCache[id], ix, iconsY, iconSize, iconSize);
                    }
                    else
                    {
                        using (var ph = new SolidBrush(ColPanel2))
                            g.FillRectangle(ph, ix, iconsY, iconSize, iconSize);
                    }

                    if (owned)
                    {
                        using (var dim = new SolidBrush(Color.FromArgb(145, 6, 13, 16)))
                            g.FillRectangle(dim, ix, iconsY, iconSize, iconSize);
                        using (var pOwned = new Pen(ColHex, 1.2f))
                            g.DrawRectangle(pOwned, ix, iconsY, iconSize, iconSize);
                        using (var fChk = new Font("Segoe UI", 8f, FontStyle.Bold))
                        using (var bHex = new SolidBrush(ColHex))
                            g.DrawString("✓", fChk, bHex, ix + 13, iconsY + 11);
                    }
                    else if (isNext)
                    {
                        using (var pNext = new Pen(ColBrass, 1.6f))
                            g.DrawRectangle(pNext, ix, iconsY, iconSize, iconSize);
                    }
                    else
                    {
                        using (var pDef = new Pen(ColSubtleEdge, 1f))
                            g.DrawRectangle(pDef, ix, iconsY, iconSize, iconSize);
                    }

                    using (var fStg = new Font("Segoe UI", 6.8f, FontStyle.Bold))
                    using (var bStg = new SolidBrush(isNext ? ColBrass : (owned ? ColHex : ColMuted)))
                    {
                        SizeF sSz = g.MeasureString(stage, fStg);
                        g.DrawString(stage, fStg, bStg, ix + (iconSize - sSz.Width) / 2f, iconsY + iconSize + 1);
                    }
                }
            }
            else
            {
                using (var fEmpty = new Font("Segoe UI", 7.4f, FontStyle.Regular))
                using (var bMuted = new SolidBrush(ColMuted))
                    g.DrawString("Sin orden de compra para este modo", fEmpty, bMuted, 7, iconsY + 6);
            }

            // Counter tip footer
            int tipY = iconsY + iconSize + 16;
            using (var linePen = new Pen(ColSubtleEdge, 1f))
                g.DrawLine(linePen, 7, tipY - 3, BaseW - 8, tipY - 3);
            using (var fTip = new Font("Segoe UI", 7.3f, FontStyle.Regular))
            using (var bTip = new SolidBrush(ColMuted))
            {
                g.DrawString(counterNote, fTip, bTip, new RectangleF(7, tipY, BaseW - 14, BaseH - tipY - 3));
            }

            if (!_isLocked)
            {
                using (var dragBarBrush = new SolidBrush(Color.FromArgb(235, 245, 158, 11)))
                    g.FillRectangle(dragBarBrush, 1, BaseH - 18, BaseW - 2, 17);
                using (var fDrag = new Font("Segoe UI", 7.2f, FontStyle.Bold))
                using (var bDrag = new SolidBrush(Color.FromArgb(15, 20, 25)))
                {
                    string dragHint = "ARRASTRAR CON RATÓN · SUELTA PARA FIJAR";
                    SizeF szH = g.MeasureString(dragHint, fDrag);
                    g.DrawString(dragHint, fDrag, bDrag, (BaseW - szH.Width) / 2, BaseH - 16);
                }
            }
        }

        private static void DrawMetricCard(Graphics g, int x, int y, int w, int h, string label, string mainVal, string subVal, Color accent)
        {
            using (var bg = new SolidBrush(ColPanel2))
                g.FillRectangle(bg, x, y, w, h);
            using (var bar = new SolidBrush(accent))
                g.FillRectangle(bar, x, y, 2, h);

            using (var fLbl = new Font("Segoe UI", 6.5f, FontStyle.Bold))
            using (var fMain = new Font("Consolas", 8.8f, FontStyle.Bold))
            using (var fSub = new Font("Segoe UI", 7.1f, FontStyle.Regular))
            using (var bMuted = new SolidBrush(ColMuted))
            using (var bAcc = new SolidBrush(accent))
            {
                g.DrawString(label, fLbl, bMuted, x + 5, y + 3);
                g.DrawString(mainVal, fMain, bAcc, x + 5, y + 14);
                g.DrawString(subVal, fSub, bMuted, x + 5, y + 29);
            }
        }
    }

    internal static class Program
    {
        [STAThread]
        private static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new OverlayForm());
        }
    }
}
