import type { PrintTargetConfig } from '@labelprint/shared';
import { t } from './i18n';

type UsbDirection = 'in' | 'out';
type UsbTransferType = 'bulk' | 'interrupt' | 'isochronous';

interface UsbEndpointLike {
  endpointNumber: number;
  direction: UsbDirection;
  type: UsbTransferType;
  packetSize?: number;
}

interface UsbAlternateLike {
  alternateSetting: number;
  interfaceClass: number;
  endpoints: UsbEndpointLike[];
}

interface UsbInterfaceLike {
  interfaceNumber: number;
  alternates: UsbAlternateLike[];
}

interface UsbConfigurationLike {
  configurationValue: number;
  interfaces: UsbInterfaceLike[];
}

interface UsbOutTransferResultLike {
  status: 'ok' | 'stall' | 'babble';
  bytesWritten?: number;
}

interface UsbDeviceLike {
  productName?: string;
  manufacturerName?: string;
  vendorId: number;
  productId: number;
  opened: boolean;
  configuration?: UsbConfigurationLike | null;
  configurations: UsbConfigurationLike[];
  open(): Promise<void>;
  close(): Promise<void>;
  selectConfiguration(configurationValue: number): Promise<void>;
  claimInterface(interfaceNumber: number): Promise<void>;
  releaseInterface(interfaceNumber: number): Promise<void>;
  selectAlternateInterface(interfaceNumber: number, alternateSetting: number): Promise<void>;
  transferOut(endpointNumber: number, data: BufferSource): Promise<UsbOutTransferResultLike>;
  clearHalt?(direction: UsbDirection, endpointNumber: number): Promise<void>;
}

interface UsbDeviceFilterLike {
  vendorId?: number;
  productId?: number;
  classCode?: number;
}

interface UsbNavigatorLike extends Navigator {
  usb?: {
    requestDevice(options: { filters: UsbDeviceFilterLike[] }): Promise<UsbDeviceLike>;
  };
}

export interface WebUsbSendResult {
  deviceName: string;
  bytes: number;
}

export interface WebUsbPrinterConnection {
  deviceName: string;
  write(data: Uint8Array): Promise<WebUsbSendResult>;
  close(): Promise<void>;
}

interface EndpointChoice {
  interfaceNumber: number;
  alternateSetting: number;
  endpointNumber: number;
  endpointType: UsbTransferType;
}

const USB_PRINTER_CLASS = 0x07;

export async function connectTsplWebUsb(target: PrintTargetConfig): Promise<WebUsbPrinterConnection> {
  const nav = navigator as UsbNavigatorLike;
  if (!nav.usb) throw new Error(t('print.webUsbUnsupported'));

  const device = await nav.usb.requestDevice({ filters: usbFilters(target) });
  let claimedInterface: number | null = null;
  let closed = false;

  try {
    await device.open();
    if (!device.configuration) {
      const configValue = device.configurations[0]?.configurationValue;
      if (configValue == null) throw new Error(t('print.webUsbNoEndpoint'));
      await device.selectConfiguration(configValue);
    }

    const choice = chooseOutEndpoint(device, target);
    if (!choice) throw new Error(t('print.webUsbNoEndpoint'));
    await device.claimInterface(choice.interfaceNumber);
    claimedInterface = choice.interfaceNumber;
    if (choice.alternateSetting !== 0) {
      await device.selectAlternateInterface(choice.interfaceNumber, choice.alternateSetting);
    }

    const deviceName = device.productName || device.manufacturerName || t('print.webUsbDevice');
    return {
      deviceName,
      async write(data: Uint8Array): Promise<WebUsbSendResult> {
        await writeChunks(device, choice.endpointNumber, data, clampInt(target.webUsbChunkSize, 64, 65536, 16384));
        return { deviceName, bytes: data.byteLength };
      },
      async close(): Promise<void> {
        if (closed) return;
        closed = true;
        if (claimedInterface != null) await device.releaseInterface(claimedInterface).catch(() => undefined);
        if (device.opened) await device.close().catch(() => undefined);
      },
    };
  } catch (e) {
    if (claimedInterface != null) await device.releaseInterface(claimedInterface).catch(() => undefined);
    if (device.opened) await device.close().catch(() => undefined);
    throw e;
  }
}

function usbFilters(target: PrintTargetConfig): UsbDeviceFilterLike[] {
  if (isFiniteInt(target.webUsbVendorId)) {
    const filter: UsbDeviceFilterLike = { vendorId: target.webUsbVendorId };
    if (isFiniteInt(target.webUsbProductId)) filter.productId = target.webUsbProductId;
    return [filter];
  }
  return [{ classCode: clampInt(target.webUsbClassCode, 0, 255, USB_PRINTER_CLASS) }];
}

function chooseOutEndpoint(device: UsbDeviceLike, target: PrintTargetConfig): EndpointChoice | null {
  const config = device.configuration;
  if (!config) return null;
  const preferredClass = isFiniteInt(target.webUsbClassCode) ? target.webUsbClassCode : USB_PRINTER_CLASS;
  const choices: Array<EndpointChoice & { score: number }> = [];

  for (const iface of config.interfaces) {
    if (isFiniteInt(target.webUsbInterfaceNumber) && iface.interfaceNumber !== target.webUsbInterfaceNumber) continue;
    for (const alt of iface.alternates) {
      if (isFiniteInt(target.webUsbAlternateSetting) && alt.alternateSetting !== target.webUsbAlternateSetting) continue;
      for (const ep of alt.endpoints) {
        if (ep.direction !== 'out') continue;
        if (isFiniteInt(target.webUsbEndpointNumber) && ep.endpointNumber !== target.webUsbEndpointNumber) continue;
        if (ep.type !== 'bulk' && ep.type !== 'interrupt') continue;
        const classScore = alt.interfaceClass === preferredClass ? 0 : 10;
        const typeScore = ep.type === 'bulk' ? 0 : 1;
        choices.push({
          interfaceNumber: iface.interfaceNumber,
          alternateSetting: alt.alternateSetting,
          endpointNumber: ep.endpointNumber,
          endpointType: ep.type,
          score: classScore + typeScore,
        });
      }
    }
  }
  choices.sort((a, b) => a.score - b.score);
  return choices[0] ?? null;
}

async function writeChunks(
  device: UsbDeviceLike,
  endpointNumber: number,
  data: Uint8Array,
  chunkSize: number,
): Promise<void> {
  for (let offset = 0; offset < data.byteLength; offset += chunkSize) {
    const chunk = data.subarray(offset, offset + chunkSize);
    const result = await device.transferOut(endpointNumber, arrayBufferFrom(chunk));
    if (result.status === 'stall') await device.clearHalt?.('out', endpointNumber).catch(() => undefined);
    if (result.status !== 'ok') {
      throw new Error(t('print.webUsbTransferFailed', { status: result.status }));
    }
  }
}

function isFiniteInt(value: unknown): value is number {
  return Number.isInteger(value);
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function arrayBufferFrom(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}
