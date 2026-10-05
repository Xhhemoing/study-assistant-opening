"use client";

import { UploadDropzone } from "./upload-dropzone";

type Props = {
  disabled?: boolean;
  onFiles: (files: File[]) => void;
};

export function CaptureDialog({ disabled, onFiles }: Props) {
  return <UploadDropzone capture="environment" disabled={disabled} onFiles={onFiles} />;
}
