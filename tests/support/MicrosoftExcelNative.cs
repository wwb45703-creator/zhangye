using System;
using System.Runtime.InteropServices;
using System.Text;

public static class MicrosoftExcelNative
{
    private delegate bool EnumWindow(IntPtr window, IntPtr context);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindow callback, IntPtr context);

    [DllImport("user32.dll")]
    private static extern bool EnumChildWindows(IntPtr parent, EnumWindow callback, IntPtr context);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr window, StringBuilder name, int length);

    [DllImport("oleacc.dll")]
    private static extern int AccessibleObjectFromWindow(
        IntPtr window, uint objectId, ref Guid interfaceId,
        [MarshalAs(UnmanagedType.Interface)] out object nativeObject);

    // Ask the document window owned by the test process for its own Excel object model.
    // The system's Excel.Application COM alias can be provided by another vendor.
    public static object DocumentWindow(uint processId)
    {
        object result = null;
        EnumWindows(delegate(IntPtr parent, IntPtr unused)
        {
            uint owner;
            GetWindowThreadProcessId(parent, out owner);
            if (owner != processId) return true;
            EnumChildWindows(parent, delegate(IntPtr child, IntPtr childContext)
            {
                var name = new StringBuilder(64);
                GetClassName(child, name, name.Capacity);
                if (name.ToString() != "EXCEL7") return true;

                var dispatch = new Guid("00020400-0000-0000-C000-000000000046");
                object candidate;
                if (AccessibleObjectFromWindow(child, 0xFFFFFFF0, ref dispatch, out candidate) != 0)
                    return true;
                result = candidate;
                return result == null;
            }, IntPtr.Zero);
            return result == null;
        }, IntPtr.Zero);
        return result;
    }
}
