/**
 * File formats: one list shared by the upload UI and the conversion worker.
 * Only formats the converter actually handles are listed (no guessing).
 */
export const SUPPORTED_3D_EXTENSIONS = ['step', 'stp', 'iges', 'igs', 'brep', 'stl', 'obj', 'glb', 'gltf'] as const;
export const SUPPORTED_2D_EXTENSIONS = ['dxf', 'pdf'] as const;

/**
 * SolidWorks native files. Proprietary binary formats: there is no open-source
 * reader, so they are rejected up front (browser) and by the converter (API),
 * never "attempted".
 */
export const SOLIDWORKS_NATIVE_EXTENSIONS = ['sldprt', 'sldasm'] as const;

// Points to STEP only: Parasolid (.x_t/.x_b) is not readable by the open-source
// OpenCASCADE build we use (occt-import-js 0.0.23 reads STEP, IGES and BREP).
export const SOLIDWORKS_NATIVE_UNSUPPORTED_MESSAGE =
  'SolidWorks native files (.sldprt/.sldasm) require a commercial converter. ' +
  'Export your file to STEP (.step) from SolidWorks, then upload that instead.';

/** README section with the SolidWorks export steps. */
export const SOLIDWORKS_EXPORT_HELP_URL =
  'https://github.com/YFermi/Dr.YoCad#exporting-from-solidworks';

export function fileExtension(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot >= 0 ? fileName.slice(dot + 1).toLowerCase() : '';
}

export function isSolidWorksNativeFile(fileName: string): boolean {
  return (SOLIDWORKS_NATIVE_EXTENSIONS as readonly string[]).includes(fileExtension(fileName));
}
