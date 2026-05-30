import React, { useEffect, useState } from "react";
import QRCode from "qrcode";

function qrPayload(asset) {
  return asset?.qrPayload || JSON.stringify({
    type: "oa.asset",
    assetNo: asset?.id || "",
    name: asset?.name || "",
    category: asset?.category || "",
    qrVersion: asset?.qrVersion || 1
  });
}

export function AssetQr({ asset }) {
  const [dataUrl, setDataUrl] = useState(asset?.qrImage || "");

  useEffect(() => {
    let cancelled = false;
    if (!asset) {
      setDataUrl("");
      return () => {
        cancelled = true;
      };
    }
    if (asset.qrImage) {
      setDataUrl(asset.qrImage);
      return () => {
        cancelled = true;
      };
    }
    QRCode.toDataURL(qrPayload(asset), {
      color: {
        dark: "#0f172a",
        light: "#ffffff"
      },
      errorCorrectionLevel: "M",
      margin: 1,
      width: 160
    }).then((url) => {
      if (!cancelled) setDataUrl(url);
    }).catch(() => {
      if (!cancelled) setDataUrl("");
    });
    return () => {
      cancelled = true;
    };
  }, [asset?.id, asset?.name, asset?.category, asset?.qrImage, asset?.qrPayload, asset?.qrVersion]);

  if (!asset) return null;

  return dataUrl ? (
    <img className="qr-image" src={dataUrl} alt={`${asset.id} 资产二维码`} />
  ) : (
    <div className="qr-image qr-fallback" aria-label={`${asset.id} 资产二维码`}>
      {asset.id}
    </div>
  );
}
