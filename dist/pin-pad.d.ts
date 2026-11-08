export interface FcPinPadElement extends HTMLElement {
    length: number;
    scrambled: boolean;
    disabled: boolean;
    label: string;
    clear(): void;
}
export interface PinEventDetail {
    pin: string;
}
/** Registers `<fc-pin-pad>` (or `name`); false when there is no DOM. */
export declare function definePinPad(name?: string): boolean;
//# sourceMappingURL=pin-pad.d.ts.map