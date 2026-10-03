#include <node_api.h>
#include <cstring>
#import <AppKit/AppKit.h>
#import <objc/runtime.h>

// Public macOS 26 properties, resolved at runtime so older SDKs can build the addon.
@protocol LumiGlassProperties
@property CGFloat cornerRadius;
@end

static const char glassKey = 0;

static NSView *ReadView(napi_env env, napi_value value) {
  bool buffer = false;
  void *bytes = nullptr;
  size_t size = 0;
  if (napi_is_buffer(env, value, &buffer) != napi_ok || !buffer ||
      napi_get_buffer_info(env, value, &bytes, &size) != napi_ok || size != sizeof(void *)) {
    napi_throw_type_error(env, nullptr, "Expected an Electron native window handle.");
    return nil;
  }
  void *pointer = nullptr;
  std::memcpy(&pointer, bytes, sizeof(pointer));
  if (!pointer) {
    napi_throw_type_error(env, nullptr, "Native window handle is empty.");
    return nil;
  }
  return (__bridge NSView *)pointer;
}

static bool OnMainThread(napi_env env) {
  if ([NSThread isMainThread]) return true;
  napi_throw_error(env, nullptr, "Widget material must be changed on the main thread.");
  return false;
}

static napi_value Apply(napi_env env, napi_callback_info info) {
  @autoreleasepool {
    size_t count = 3;
    napi_value args[3];
    bool dark = false;
    if (napi_get_cb_info(env, info, &count, args, nullptr, nullptr) != napi_ok || count != 2 ||
        napi_get_value_bool(env, args[1], &dark) != napi_ok) {
      napi_throw_type_error(env, nullptr, "Expected a native window handle and theme flag.");
      return nullptr;
    }
    if (!OnMainThread(env)) return nullptr;
    NSView *root = ReadView(env, args[0]);
    if (!root) return nullptr;
    root.window.appearance = [NSAppearance appearanceNamed:dark ? NSAppearanceNameDarkAqua : NSAppearanceNameAqua];
    Class glassClass = NSClassFromString(@"NSGlassEffectView");
    bool supported = NSProcessInfo.processInfo.operatingSystemVersion.majorVersion >= 26 &&
                     glassClass && [glassClass instancesRespondToSelector:@selector(setCornerRadius:)];
    if (supported) {
      NSView<LumiGlassProperties> *glass = objc_getAssociatedObject(root, &glassKey);
      if (!glass) {
        glass = [[glassClass alloc] initWithFrame:NSInsetRect(root.bounds, 2, 2)];
        glass.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
        glass.cornerRadius = 8;
        [root addSubview:glass positioned:NSWindowBelow relativeTo:nil];
        // Ownership follows the window instead of a process-global view registry.
        objc_setAssociatedObject(root, &glassKey, glass, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
      }
    }
    napi_value result;
    napi_get_boolean(env, supported, &result);
    return result;
  }
}

static napi_value Remove(napi_env env, napi_callback_info info) {
  @autoreleasepool {
    size_t count = 2;
    napi_value args[2];
    if (napi_get_cb_info(env, info, &count, args, nullptr, nullptr) != napi_ok || count != 1) {
      napi_throw_type_error(env, nullptr, "Expected a native window handle.");
      return nullptr;
    }
    if (!OnMainThread(env)) return nullptr;
    NSView *root = ReadView(env, args[0]);
    if (!root) return nullptr;
    NSView *glass = objc_getAssociatedObject(root, &glassKey);
    [glass removeFromSuperview];
    objc_setAssociatedObject(root, &glassKey, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    napi_value result;
    napi_get_undefined(env, &result);
    return result;
  }
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
    {"apply", nullptr, Apply, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"remove", nullptr, Remove, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, 2, properties);
  return exports;
}

NAPI_MODULE(lumi_widget_glass, Init)
