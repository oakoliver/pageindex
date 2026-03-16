/**
 * Type declarations for pdf-poppler
 */

declare module "pdf-poppler" {
  export interface ConvertOptions {
    /** Output format (png, jpeg, tiff) */
    format: "png" | "jpeg" | "tiff";
    /** Output directory */
    out_dir: string;
    /** Output filename prefix */
    out_prefix: string;
    /** Page number to convert (null for all pages) */
    page?: number | null;
    /** Scale/DPI setting */
    scale?: number;
  }

  export interface PdfInfo {
    pages?: number;
    title?: string;
    author?: string;
    subject?: string;
    creator?: string;
    producer?: string;
    creationDate?: string;
    modDate?: string;
  }

  /**
   * Convert PDF to images
   */
  export function convert(
    pdfPath: string,
    options: ConvertOptions
  ): Promise<void>;

  /**
   * Get PDF information
   */
  export function info(pdfPath: string): Promise<PdfInfo>;
}
