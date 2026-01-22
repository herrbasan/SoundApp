//
// Created by Tobias Hegemann on 20.09.22.
//

#ifndef RUBBERBAND_WEB_SRC_REALTIME_RUBBERBAND_H_
#define RUBBERBAND_WEB_SRC_REALTIME_RUBBERBAND_H_

#include <RubberBandStretcher.h>
#include "../../lib/third-party/rubberband-3.0.0/src/common/RingBuffer.h"

class RealtimeRubberBand {
 public:
  RealtimeRubberBand(size_t sampleRate, size_t channel_count, bool high_quality = false, bool formant_preserved = false, int transients = 0, int detector = 0, size_t block_size = 512);
  ~RealtimeRubberBand();

  int getVersion();

  void setTempo(double tempo);

  void setPitch(double tempo);

  void setFormantScale(double scale);

  __attribute__((unused)) size_t getSamplesAvailable();

  void push(uintptr_t input_ptr, size_t sample_size);

  __attribute__((unused)) void pull(uintptr_t output_ptr, size_t sample_size);

 private:
  void updateRatio();

  void fetchProcessed();

  RubberBand::RubberBandStretcher *stretcher_;
  RubberBand::RingBuffer<float> **output_buffer_;

  size_t start_pad_samples_;

  size_t start_delay_samples_;

  size_t channel_count_;
  float **scratch_;

  size_t buffer_size_ = 0;

  size_t block_size_ = 512;
  const size_t kReserve_ = 8192;
};

#endif //RUBBERBAND_WEB_SRC_REALTIME_RUBBERBAND_H_
