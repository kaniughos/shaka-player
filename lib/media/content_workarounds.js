/*! @license
 * Shaka Player
 * Copyright 2016 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

goog.provide('shaka.media.ContentWorkarounds');

goog.require('goog.asserts');
goog.require('shaka.log');
goog.require('shaka.util.BufferUtils');
goog.require('shaka.util.Error');
goog.require('shaka.util.Lazy');
goog.require('shaka.util.Mp4Parser');
goog.require('shaka.util.Platform');
goog.require('shaka.util.Uint8ArrayUtils');


/**
 * @summary
 * A collection of methods to work around content issues on various platforms.
 */
shaka.media.ContentWorkarounds = class {
  /**
   * Transform the init segment into a new init segment buffer that indicates
   * encryption.  If the init segment already indicates encryption, return the
   * original init segment.
   *
   * Should only be called for MP4 init segments, and only on platforms that
   * need this workaround.
   *
   * @param {!BufferSource} initSegmentBuffer
   * @param {?string} uri
   * @return {!Uint8Array}
   * @see https://github.com/shaka-project/shaka-player/issues/2759
   */
  static fakeEncryption(initSegmentBuffer, uri) {
    const ContentWorkarounds = shaka.media.ContentWorkarounds;
    const initSegment = shaka.util.BufferUtils.toUint8(initSegmentBuffer);
    let modifiedInitSegment = initSegment;
    let isEncrypted = false;
    /** @type {shaka.extern.ParsedBox} */
    let stsdBox;
    const ancestorBoxes = [];

    const onSimpleAncestorBox = (box) => {
      ancestorBoxes.push(box);
      shaka.util.Mp4Parser.children(box);
    };

    const onEncryptionMetadataBox = (box) => {
      isEncrypted = true;
    };

    // Multiplexed content could have multiple boxes that we need to modify.
    // Add to this array in order of box offset.  This will be important later,
    // when we process the boxes.
    /** @type {!Array.<{box: shaka.extern.ParsedBox, newType: number}>} */
    const boxesToModify = [];

    new shaka.util.Mp4Parser()
        .box('moov', onSimpleAncestorBox)
        .box('trak', onSimpleAncestorBox)
        .box('mdia', onSimpleAncestorBox)
        .box('minf', onSimpleAncestorBox)
        .box('stbl', onSimpleAncestorBox)
        .fullBox('stsd', (box) => {
          stsdBox = box;
          ancestorBoxes.push(box);
          shaka.util.Mp4Parser.sampleDescription(box);
        })
        .fullBox('encv', onEncryptionMetadataBox)
        .fullBox('enca', onEncryptionMetadataBox)
        .fullBox('dvav', (box) => {
          boxesToModify.push({
            box,
            newType: ContentWorkarounds.BOX_TYPE_ENCV_,
          });
        })
        .fullBox('dva1', (box) => {
          boxesToModify.push({
            box,
            newType: ContentWorkarounds.BOX_TYPE_ENCV_,
          });
        })
        .fullBox('dvh1', (box) => {
          boxesToModify.push({
            box,
            newType: ContentWorkarounds.BOX_TYPE_ENCV_,
          });
        })
        .fullBox('dvhe', (box) => {
          boxesToModify.push({
            box,
            newType: ContentWorkarounds.BOX_TYPE_ENCV_,
          });
        })
        .fullBox('dvc1', (box) => {
          boxesToModify.push({
            box,
            newType: ContentWorkarounds.BOX_TYPE_ENCV_,
          });
        })
        .fullBox('dvi1', (box) => {
          boxesToModify.push({
            box,
            newType: ContentWorkarounds.BOX_TYPE_ENCV_,
          });
        })
        .fullBox('hev1', (box) => {
          boxesToModify.push({
            box,
            newType: ContentWorkarounds.BOX_TYPE_ENCV_,
          });
        })
        .fullBox('hvc1', (box) => {
          boxesToModify.push({
            box,
            newType: ContentWorkarounds.BOX_TYPE_ENCV_,
          });
        })
        .fullBox('avc1', (box) => {
          boxesToModify.push({
            box,
            newType: ContentWorkarounds.BOX_TYPE_ENCV_,
          });
        })
        .fullBox('avc3', (box) => {
          boxesToModify.push({
            box,
            newType: ContentWorkarounds.BOX_TYPE_ENCV_,
          });
        })
        .fullBox('ac-3', (box) => {
          boxesToModify.push({
            box,
            newType: ContentWorkarounds.BOX_TYPE_ENCA_,
          });
        })
        .fullBox('ec-3', (box) => {
          boxesToModify.push({
            box,
            newType: ContentWorkarounds.BOX_TYPE_ENCA_,
          });
        })
        .fullBox('ac-4', (box) => {
          boxesToModify.push({
            box,
            newType: ContentWorkarounds.BOX_TYPE_ENCA_,
          });
        })
        .fullBox('mp4a', (box) => {
          boxesToModify.push({
            box,
            newType: ContentWorkarounds.BOX_TYPE_ENCA_,
          });
        }).parse(initSegment);

    if (isEncrypted) {
      shaka.log.debug('Init segment already indicates encryption.');
      return initSegment;
    }

    if (boxesToModify.length == 0 || !stsdBox) {
      shaka.log.error('Failed to find boxes needed to fake encryption!');
      shaka.log.v2('Failed init segment (hex):',
          shaka.util.Uint8ArrayUtils.toHex(initSegment));
      throw new shaka.util.Error(
          shaka.util.Error.Severity.CRITICAL,
          shaka.util.Error.Category.MEDIA,
          shaka.util.Error.Code.CONTENT_TRANSFORMATION_FAILED,
          uri);
    }

    // Modify boxes in order from largest offset to smallest, so that earlier
    // boxes don't have their offsets changed before we process them.
    boxesToModify.reverse();  // in place!
    for (const workItem of boxesToModify) {
      const insertedBoxType =
          shaka.util.Mp4Parser.typeToString(workItem.newType);
      shaka.log.debug(`Inserting "${insertedBoxType}" box into init segment.`);
      modifiedInitSegment = ContentWorkarounds.insertEncryptionMetadata_(
          modifiedInitSegment, stsdBox, workItem.box, ancestorBoxes,
          workItem.newType);
    }

    // Edge Windows needs the unmodified init segment to be appended after the
    // patched one, otherwise video element throws following error:
    // CHUNK_DEMUXER_ERROR_APPEND_FAILED: Sample encryption info is not
    // available.
    if (shaka.util.Platform.isEdge() && shaka.util.Platform.isWindows() &&
        !shaka.util.Platform.isXboxOne()) {
      const doubleInitSegment = new Uint8Array(initSegment.byteLength +
        modifiedInitSegment.byteLength);
      doubleInitSegment.set(modifiedInitSegment);
      doubleInitSegment.set(initSegment, modifiedInitSegment.byteLength);
      return doubleInitSegment;
    }

    return modifiedInitSegment;
  }

  /**
   * Insert an encryption metadata box ("encv" or "enca" box) into the MP4 init
   * segment, based on the source box ("mp4a", "avc1", etc).  Returns a new
   * buffer containing the modified init segment.
   *
   * @param {!Uint8Array} initSegment
   * @param {shaka.extern.ParsedBox} stsdBox
   * @param {shaka.extern.ParsedBox} sourceBox
   * @param {!Array.<shaka.extern.ParsedBox>} ancestorBoxes
   * @param {number} metadataBoxType
   * @return {!Uint8Array}
   * @private
   */
  static insertEncryptionMetadata_(
      initSegment, stsdBox, sourceBox, ancestorBoxes, metadataBoxType) {
    const ContentWorkarounds = shaka.media.ContentWorkarounds;
    const metadataBoxArray = ContentWorkarounds.createEncryptionMetadata_(
        initSegment, sourceBox, metadataBoxType);

    // Construct a new init segment array with room for the encryption metadata
    // box we're adding.
    const newInitSegment =
        new Uint8Array(initSegment.byteLength + metadataBoxArray.byteLength);

    // For Xbox One & Edge, we cut and insert at the start of the source box.
    // For other platforms, we cut and insert at the end of the source box. It's
    // not clear why this is necessary on Xbox One, but it seems to be evidence
    // of another bug in the firmware implementation of MediaSource & EME.
    const cutPoint =
      (shaka.util.Platform.isXboxOne() || shaka.util.Platform.isEdge()) ?
        sourceBox.start :
        sourceBox.start + sourceBox.size;

    // The data before the cut point will be copied to the same location as
    // before.  The data after that will be appended after the added metadata
    // box.
    const beforeData = initSegment.subarray(0, cutPoint);
    const afterData = initSegment.subarray(cutPoint);

    newInitSegment.set(beforeData);
    newInitSegment.set(metadataBoxArray, cutPoint);
    newInitSegment.set(afterData, cutPoint + metadataBoxArray.byteLength);

    // The parents up the chain from the encryption metadata box need their
    // sizes adjusted to account for the added box.  These offsets should not be
    // changed, because they should all be within the first section we copy.
    for (const box of ancestorBoxes) {
      goog.asserts.assert(box.start < cutPoint,
          'Ancestor MP4 box found in the wrong location!  ' +
          'Modified init segment will not make sense!');
      ContentWorkarounds.updateBoxSize_(
          newInitSegment, box.start, box.size + metadataBoxArray.byteLength);
    }

    // Add one to the sample entries field of the "stsd" box.  This is a 4-byte
    // field just past the box header.
    const stsdBoxView = shaka.util.BufferUtils.toDataView(
        newInitSegment, stsdBox.start);
    const stsdBoxHeaderSize = shaka.util.Mp4Parser.headerSize(stsdBox);
    const numEntries = stsdBoxView.getUint32(stsdBoxHeaderSize);
    stsdBoxView.setUint32(stsdBoxHeaderSize, numEntries + 1);

    return newInitSegment;
  }

  /**
   * Create an encryption metadata box ("encv" or "enca" box), based on the
   * source box ("mp4a", "avc1", etc).  Returns a new buffer containing the
   * encryption metadata box.
   *
   * @param {!Uint8Array} initSegment
   * @param {shaka.extern.ParsedBox} sourceBox
   * @param {number} metadataBoxType
   * @return {!Uint8Array}
   * @private
   */
  static createEncryptionMetadata_(initSegment, sourceBox, metadataBoxType) {
    const ContentWorkarounds = shaka.media.ContentWorkarounds;
    const sinfBoxArray = ContentWorkarounds.CANNED_SINF_BOX_.value();

    // Create a subarray which points to the source box data.
    const sourceBoxArray = initSegment.subarray(
        /* start= */ sourceBox.start,
        /* end= */ sourceBox.start + sourceBox.size);

    // Create a view on the source box array.
    const sourceBoxView = shaka.util.BufferUtils.toDataView(sourceBoxArray);

    // Create an array to hold the new encryption metadata box, which is based
    // on the source box.
    const metadataBoxArray = new Uint8Array(
        sourceBox.size + sinfBoxArray.byteLength);

    // Copy the source box into the new array.
    metadataBoxArray.set(sourceBoxArray, /* targetOffset= */ 0);

    // Change the box type.
    const metadataBoxView = shaka.util.BufferUtils.toDataView(metadataBoxArray);
    metadataBoxView.setUint32(
        ContentWorkarounds.BOX_TYPE_OFFSET_, metadataBoxType);

    // Append the "sinf" box to the encryption metadata box.
    metadataBoxArray.set(sinfBoxArray, /* targetOffset= */ sourceBox.size);

    // Update the "sinf" box's format field (in the child "frma" box) to reflect
    // the format of the original source box.
    const sourceBoxType = sourceBoxView.getUint32(
        ContentWorkarounds.BOX_TYPE_OFFSET_);
    metadataBoxView.setUint32(
        sourceBox.size + ContentWorkarounds.CANNED_SINF_BOX_FORMAT_OFFSET_,
        sourceBoxType);

    // Now update the encryption metadata box size.
    ContentWorkarounds.updateBoxSize_(
        metadataBoxArray, /* boxStart= */ 0, metadataBoxArray.byteLength);

    return metadataBoxArray;
  }

  /**
   * Modify an MP4 box's size field in-place.
   *
   * @param {!Uint8Array} dataArray
   * @param {number} boxStart The start position of the box in dataArray.
   * @param {number} newBoxSize The new size of the box.
   * @private
   */
  static updateBoxSize_(dataArray, boxStart, newBoxSize) {
    const ContentWorkarounds = shaka.media.ContentWorkarounds;
    const boxView = shaka.util.BufferUtils.toDataView(dataArray, boxStart);
    const sizeField = boxView.getUint32(ContentWorkarounds.BOX_SIZE_OFFSET_);
    if (sizeField == 0) { // Means "the rest of the box".
      // No adjustment needed for this box.
    } else if (sizeField == 1) { // Means "use 64-bit size box".
      // Set the 64-bit int in two 32-bit parts.
      // The high bits should definitely be 0 in practice, but we're being
      // thorough here.
      boxView.setUint32(ContentWorkarounds.BOX_SIZE_64_OFFSET_,
          newBoxSize >> 32);
      boxView.setUint32(ContentWorkarounds.BOX_SIZE_64_OFFSET_ + 4,
          newBoxSize & 0xffffffff);
    } else { // Normal 32-bit size field.
      // Not checking the size of the value here, since a box larger than 4GB is
      // unrealistic.
      boxView.setUint32(ContentWorkarounds.BOX_SIZE_OFFSET_, newBoxSize);
    }
  }

  /**
   * Transform the init segment into a new init segment buffer that indicates
   * EC-3 as audio codec instead of AC-3. Even though any EC-3 decoder should
   * be able to decode AC-3 streams, there are platforms that do not accept
   * AC-3 as codec.
   *
   * Should only be called for MP4 init segments, and only on platforms that
   * need this workaround. Returns a new buffer containing the modified init
   * segment.
   *
   * @param {!BufferSource} initSegmentBuffer
   * @return {!Uint8Array}
   */
  static fakeEC3(initSegmentBuffer) {
    const ContentWorkarounds = shaka.media.ContentWorkarounds;
    const initSegment = shaka.util.BufferUtils.toUint8(initSegmentBuffer);
    const ancestorBoxes = [];

    const onSimpleAncestorBox = (box) => {
      ancestorBoxes.push({start: box.start, size: box.size});
      shaka.util.Mp4Parser.children(box);
    };

    new shaka.util.Mp4Parser()
        .box('moov', onSimpleAncestorBox)
        .box('trak', onSimpleAncestorBox)
        .box('mdia', onSimpleAncestorBox)
        .box('minf', onSimpleAncestorBox)
        .box('stbl', onSimpleAncestorBox)
        .box('stsd', (box) => {
          ancestorBoxes.push({start: box.start, size: box.size});
          const stsdBoxView = shaka.util.BufferUtils.toDataView(
              initSegment, box.start);
          for (let i=0; i<box.size; i++) {
            const codecTag = stsdBoxView.getUint32(i);
            if (codecTag == ContentWorkarounds.BOX_TYPE_AC_3_) {
              stsdBoxView.setUint32(i, ContentWorkarounds.BOX_TYPE_EC_3_);
            } else if (codecTag == ContentWorkarounds.BOX_TYPE_DAC3_) {
              stsdBoxView.setUint32(i, ContentWorkarounds.BOX_TYPE_DEC3_);
            }
          }
        }).parse(initSegment);

    return initSegment;
  }
};

/**
 * A canned "sinf" box for use when adding fake encryption metadata to init
 * segments.
 *
 * @const {!shaka.util.Lazy.<!Uint8Array>}
 * @private
 * @see https://github.com/shaka-project/shaka-player/issues/2759
 */
shaka.media.ContentWorkarounds.CANNED_SINF_BOX_ =
    new shaka.util.Lazy(() => new Uint8Array([
      // sinf box
      // Size: 0x50 = 80
      0x00, 0x00, 0x00, 0x50,

      // Type: sinf
      0x73, 0x69, 0x6e, 0x66,

      // Children of sinf...

      // frma box
      // Size: 0x0c = 12
      0x00, 0x00, 0x00, 0x0c,

      // Type: frma (child of sinf)
      0x66, 0x72, 0x6d, 0x61,

      // Format: filled in later based on the source box ("avc1", "mp4a", etc)
      0x00, 0x00, 0x00, 0x00,
      // end of frma box

      // schm box
      // Size: 0x14 = 20
      0x00, 0x00, 0x00, 0x14,

      // Type: schm (child of sinf)
      0x73, 0x63, 0x68, 0x6d,

      // Version: 0, Flags: 0
      0x00, 0x00, 0x00, 0x00,

      // Scheme: cenc
      0x63, 0x65, 0x6e, 0x63,

      // Scheme version: 1.0
      0x00, 0x01, 0x00, 0x00,
      // end of schm box

      // schi box
      // Size: 0x28 = 40
      0x00, 0x00, 0x00, 0x28,

      // Type: schi (child of sinf)
      0x73, 0x63, 0x68, 0x69,

      // Children of schi...

      // tenc box
      // Size: 0x20 = 32
      0x00, 0x00, 0x00, 0x20,

      // Type: tenc (child of schi)
      0x74, 0x65, 0x6e, 0x63,

      // Version: 0, Flags: 0
      0x00, 0x00, 0x00, 0x00,

      // Reserved fields
      0x00, 0x00,

      // Default protected: true
      0x01,

      // Default per-sample IV size: 8
      0x08,

      // Default key ID: all zeros (dummy)
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      // end of tenc box

      // end of schi box

      // end of sinf box
    ]));

/**
 * The location of the format field in the "frma" box inside the canned "sinf"
 * box above.
 *
 * @const {number}
 * @private
 */
shaka.media.ContentWorkarounds.CANNED_SINF_BOX_FORMAT_OFFSET_ = 0x10;

/**
 * Offset to a box's size field.
 *
 * @const {number}
 * @private
 */
shaka.media.ContentWorkarounds.BOX_SIZE_OFFSET_ = 0;

/**
 * Offset to a box's type field.
 *
 * @const {number}
 * @private
 */
shaka.media.ContentWorkarounds.BOX_TYPE_OFFSET_ = 4;

/**
 * Offset to a box's 64-bit size field, if it has one.
 *
 * @const {number}
 * @private
 */
shaka.media.ContentWorkarounds.BOX_SIZE_64_OFFSET_ = 8;

/**
 * Box type for "encv".
 *
 * @const {number}
 * @private
 */
shaka.media.ContentWorkarounds.BOX_TYPE_ENCV_ = 0x656e6376;

/**
 * Box type for "enca".
 *
 * @const {number}
 * @private
 */
shaka.media.ContentWorkarounds.BOX_TYPE_ENCA_ = 0x656e6361;

/**
 * Box type for "ac-3".
 *
 * @const {number}
 * @private
 */
shaka.media.ContentWorkarounds.BOX_TYPE_AC_3_ = 0x61632d33;

/**
 * Box type for "dac3".
 *
 * @const {number}
 * @private
 */
shaka.media.ContentWorkarounds.BOX_TYPE_DAC3_ = 0x64616333;

/**
 * Box type for "ec-3".
 *
 * @const {number}
 * @private
 */
shaka.media.ContentWorkarounds.BOX_TYPE_EC_3_ = 0x65632d33;

/**
 * Box type for "dec3".
 *
 * @const {number}
 * @private
 */
shaka.media.ContentWorkarounds.BOX_TYPE_DEC3_ = 0x64656333;
